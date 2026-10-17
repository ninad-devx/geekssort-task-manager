"""Database engine, sessions and schema bootstrap.

One engine is built at import time from `settings.DATABASE_URL`, so the choice
of database is made entirely by the environment: a `sqlite:///` URL gives the
local development file, a `postgresql+psycopg://` URL gives the VPS database.
Nothing downstream asks which one it got -- every caller uses `SessionLocal`,
`get_db` or `write_tx` and gets whichever engine this module built.

The dialect does leak in exactly two places, and both are handled here rather
than scattered through the routers:

* `write_tx` opens SQLite's `BEGIN IMMEDIATE` to take the single writer lock up
  front. Postgres has no such statement and does not need it -- MVCC already
  lets readers run while a writer works.
* `apply_schema_repairs` and `install_audit_triggers` hand-write DDL, which is
  spelled differently per engine. Each has a branch per dialect.
"""

from __future__ import annotations

import time
from collections.abc import Iterator
from contextlib import contextmanager

from sqlalchemy import create_engine, event, text
from sqlalchemy.engine import Engine
from sqlalchemy.orm import Session, sessionmaker

from app.config import BACKEND_DIR, DatabaseConfigurationError, resolve_database_url, settings

DATA_DIR = BACKEND_DIR / "data"
DATA_DIR.mkdir(parents=True, exist_ok=True)

DATABASE_URL = resolve_database_url()
IS_SQLITE = settings.is_sqlite
IS_POSTGRES = settings.is_postgresql

# A session-level advisory lock key, so two replicas booting at the same moment
# take turns creating the schema instead of racing each other into a duplicate
# -type error. Any constant works; it just has to be stable and unlikely to
# collide with another application sharing the same database.
_INIT_LOCK_KEY = 0x7A550001


def _build_engine(url: str) -> Engine:
    """Create the engine, applying only the arguments the chosen dialect accepts.

    `connect_args={"check_same_thread": ...}` is a pysqlite keyword: handing it to
    psycopg raises `TypeError: invalid connection option` at engine creation, so
    the two branches below must stay separate rather than merged.
    """
    kwargs: dict[str, object] = {"future": True}
    if settings.is_sqlite:
        # FastAPI serves requests from a thread pool, so the same sqlite3
        # connection object is handed to more than one thread over its life.
        # SQLAlchemy's pool already serialises access to it; sqlite3 only needs
        # to stop asserting that its creator thread is the only caller.
        kwargs["connect_args"] = {"check_same_thread": False}
    else:
        kwargs["pool_pre_ping"] = True
        kwargs["pool_size"] = settings.DB_POOL_SIZE
        kwargs["max_overflow"] = settings.DB_MAX_OVERFLOW
        kwargs["pool_timeout"] = settings.DB_POOL_TIMEOUT_SECONDS
        kwargs["pool_recycle"] = settings.DB_POOL_RECYCLE_SECONDS
    try:
        return create_engine(url, **kwargs)
    except ModuleNotFoundError as exc:  # pragma: no cover - environment dependent
        raise DatabaseConfigurationError(
            f"The driver for {settings.safe_database_url} is not installed ({exc}). "
            f"Run: pip install -r requirements.txt"
        ) from exc
    except Exception as exc:  # pragma: no cover - environment dependent
        raise DatabaseConfigurationError(
            f"Could not create a database engine for {settings.safe_database_url}: {exc}"
        ) from exc


engine = _build_engine(DATABASE_URL)

SessionLocal = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False, future=True)


if IS_SQLITE:

    @event.listens_for(engine, "connect")
    def _sqlite_pragmas(dbapi_conn, _record):
        """SQLite's durability and concurrency knobs, one per new connection.

        Registered only for SQLite. `PRAGMA` is not SQL, so executing it against
        Postgres would fail on every new pooled connection.

        WAL lets the app read while a write is in flight; `foreign_keys=ON` is
        off by default in SQLite, and the schema leans on those constraints;
        `busy_timeout` turns a contended write into a short wait rather than an
        immediate "database is locked".
        """
        cur = dbapi_conn.cursor()
        cur.execute("PRAGMA journal_mode=WAL")
        cur.execute("PRAGMA foreign_keys=ON")
        cur.execute("PRAGMA busy_timeout=5000")
        cur.execute("PRAGMA synchronous=NORMAL")
        cur.close()


@contextmanager
def write_tx() -> Iterator[Session]:
    """One write transaction containing the data change and its audit events (D-05, D-12)."""
    db = SessionLocal()
    try:
        if IS_SQLITE:
            # Take the single writer slot before the first read so a read-then-
            # write handler cannot be upgraded to a write after another writer
            # has already started. Postgres needs no equivalent: any write
            # blocks only its own row, and `BEGIN IMMEDIATE` is not valid SQL
            # there -- it would abort the transaction.
            db.execute(text("BEGIN IMMEDIATE"))
        try:
            yield db
            db.commit()
        except Exception:
            db.rollback()
            raise
    finally:
        db.close()


def get_db() -> Iterator[Session]:
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


def wait_for_database(timeout: float | None = None) -> None:
    """Prove the database answers before the app starts serving.

    With the default `DB_CONNECT_WAIT_SECONDS=0` that is a single `SELECT 1`, so
    a wrong host or password fails the boot with the driver's own error instead
    of surfacing as a 500 on the first request. Setting the budget above zero
    additionally retries for that many seconds, which is only useful when
    nothing else is gating startup. Either way the wait is bounded and a
    permanent misconfiguration still raises -- it is never hidden behind a retry
    loop that never ends.
    """
    budget = settings.DB_CONNECT_WAIT_SECONDS if timeout is None else timeout
    if budget <= 0:
        _assert_reachable()
        return
    deadline = time.monotonic() + budget
    while True:
        try:
            _assert_reachable()
            return
        except Exception as exc:  # noqa: BLE001 - re-raised below
            if time.monotonic() >= deadline:
                raise DatabaseConnectionError(budget, exc) from exc
            time.sleep(settings.DB_CONNECT_WAIT_INTERVAL_SECONDS)


class DatabaseConnectionError(RuntimeError):
    def __init__(self, waited: float, cause: Exception):
        super().__init__(
            f"Could not reach the database after waiting {waited:.0f}s. "
            f"Target: {settings.safe_database_url}. "
            f"Last driver error: {cause}. "
            f"Check that PostgreSQL is running, that the host/port/database in "
            f"DATABASE_URL are correct, and that the credentials are accepted."
        )
        self.cause = cause


def _assert_reachable() -> None:
    with engine.connect() as conn:
        conn.execute(text("SELECT 1"))


def init_db() -> None:
    """Create anything the schema is missing. Safe to run on every boot.

    `create_all` only ever adds whole missing tables, indexes and constraints;
    it never alters one. That is the right behaviour for a schema created from
    these models and it is what keeps a fresh PostgreSQL deployment honest: the
    same call that the SQLite development workflow already runs on every start
    builds the complete production schema, with no SQLite file required.
    """
    if IS_POSTGRES:
        # create_all opens its own connections, so the lock has to be held on a
        # separate session-scoped advisory lock rather than a transaction.
        with engine.connect() as lock_conn:
            lock_conn.execute(text("SELECT pg_advisory_lock(:k)"), {"k": _INIT_LOCK_KEY})
            lock_conn.commit()
            try:
                _create_schema()
            finally:
                lock_conn.execute(text("SELECT pg_advisory_unlock(:k)"), {"k": _INIT_LOCK_KEY})
                lock_conn.commit()
        return
    _create_schema()


def _create_schema() -> None:
    from app import models  # noqa: F401

    Base.metadata.create_all(bind=engine)
    conn = engine.raw_connection()
    try:
        install_audit_triggers(conn)
        apply_schema_repairs(conn)
    finally:
        conn.close()


def apply_schema_repairs(db_conn) -> None:
    """Bring an existing database in line with the current models.

    `create_all` only ever adds whole missing tables; it never alters one. Two
    corrections have to be applied by hand to a database created before them,
    and both are idempotent so this is safe to run on every boot.
    """
    from app.models import utcnow

    cur = db_conn.cursor()
    try:
        # A soft-deleted row with `ended_at IS NULL` used to occupy the running
        # timer slot forever. Close them so the corrected index can be built.
        if IS_SQLITE:
            # Passed as text: the default datetime adapter is deprecated, and
            # SQLite has no native datetime type anyway.
            cur.execute(
                "UPDATE task_logs SET ended_at = ?, duration_seconds = COALESCE(duration_seconds, 0) "
                "WHERE ended_at IS NULL AND deleted_at IS NOT NULL",
                (utcnow().isoformat(sep=" "),),
            )
        else:
            # psycopg3 adapts a real datetime to `timestamp`, which is exactly
            # the column type here, so the value needs no manual formatting.
            cur.execute(
                "UPDATE task_logs SET ended_at = %s, duration_seconds = COALESCE(duration_seconds, 0) "
                "WHERE ended_at IS NULL AND deleted_at IS NOT NULL",
                (utcnow(),),
            )
        cur.execute("DROP INDEX IF EXISTS uq_running_session_per_user_task")
        cur.execute(
            "CREATE UNIQUE INDEX IF NOT EXISTS uq_running_session_per_user_task "
            "ON task_logs (user_id, task_id) "
            "WHERE ended_at IS NULL AND deleted_at IS NULL"
        )
        cur.execute(
            "CREATE UNIQUE INDEX IF NOT EXISTS uq_folder_sibling_name "
            "ON workspace_folders (parent_id, name) WHERE deleted_at IS NULL"
        )
    except Exception:
        # A database that predates these tables cannot be repaired here, and a
        # failed repair must not stop the app from starting.
        db_conn.rollback()
    finally:
        cur.close()
    db_conn.commit()


def install_audit_triggers(db_conn) -> None:
    """Make `audit_events` append-only at the database level.

    The application never updates or deletes these rows; the triggers make that
    a guarantee rather than a convention. Both engines express it differently:
    SQLite has `CREATE TRIGGER IF NOT EXISTS` and `RAISE(ABORT)`, Postgres has
    neither, so it needs an explicit drop first and a plpgsql function.
    """
    cur = db_conn.cursor()
    try:
        if IS_SQLITE:
            statements = (
                """
                CREATE TRIGGER IF NOT EXISTS audit_events_no_update
                BEFORE UPDATE ON audit_events
                BEGIN
                  SELECT RAISE(ABORT, 'audit_events is append-only');
                END
                """,
                """
                CREATE TRIGGER IF NOT EXISTS audit_events_no_delete
                BEFORE DELETE ON audit_events
                BEGIN
                  SELECT RAISE(ABORT, 'audit_events is append-only');
                END
                """,
            )
        else:
            statements = (
                "CREATE OR REPLACE FUNCTION audit_events_append_only() RETURNS trigger AS $$ "
                "BEGIN RAISE EXCEPTION 'audit_events is append-only' "
                "USING ERRCODE = 'restrict_violation'; END; $$ LANGUAGE plpgsql",
                "DROP TRIGGER IF EXISTS audit_events_no_update ON audit_events",
                "CREATE TRIGGER audit_events_no_update BEFORE UPDATE ON audit_events "
                "FOR EACH ROW EXECUTE FUNCTION audit_events_append_only()",
                "DROP TRIGGER IF EXISTS audit_events_no_delete ON audit_events",
                "CREATE TRIGGER audit_events_no_delete BEFORE DELETE ON audit_events "
                "FOR EACH ROW EXECUTE FUNCTION audit_events_append_only()",
            )
        for sql in statements:
            cur.execute(sql)
    finally:
        cur.close()
    db_conn.commit()


from app.models import Base  # noqa: E402
