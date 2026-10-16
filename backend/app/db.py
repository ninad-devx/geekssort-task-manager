from __future__ import annotations

from collections.abc import Iterator
from contextlib import contextmanager

from sqlalchemy import create_engine, event
from sqlalchemy.orm import Session, sessionmaker

from app.config import BACKEND_DIR, settings

DATA_DIR = BACKEND_DIR / "data"
DATA_DIR.mkdir(parents=True, exist_ok=True)

engine = create_engine(
    settings.DATABASE_URL,
    future=True,
    connect_args={"check_same_thread": False},
)

SessionLocal = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False, future=True)


@event.listens_for(engine, "connect")
def _sqlite_pragmas(dbapi_conn, _record):
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
        db.execute(__import__("sqlalchemy").text("BEGIN IMMEDIATE"))
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


def init_db() -> None:
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
        cur.execute(
            "UPDATE task_logs SET ended_at = ?, duration_seconds = COALESCE(duration_seconds, 0) "
            "WHERE ended_at IS NULL AND deleted_at IS NOT NULL",
            # Passed as text: the default datetime adapter is deprecated, and
            # SQLite has no native datetime type anyway.
            (utcnow().isoformat(sep=" "),),
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
    cur = db_conn.cursor()
    for sql in (
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
    ):
        cur.execute(sql)
    cur.close()
    db_conn.commit()


from app.models import Base  # noqa: E402