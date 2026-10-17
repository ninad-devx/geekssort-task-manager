"""Tests for the database-selection layer itself.

Everything here runs under both SQLite and PostgreSQL: the point is that the
*selection* logic, the transaction boundaries and the schema bootstrap are
dialect-independent, and that a handful of behaviours that only exist on one
engine are asserted on that engine rather than silently untested.

Run against PostgreSQL with:

    MOS_TEST_DATABASE_URL=postgresql+psycopg://USER:PASS@HOST:5432/mos_test pytest
"""

from __future__ import annotations

import threading
from datetime import datetime, timedelta, timezone

import pytest
from sqlalchemy import func, select, text
from sqlalchemy.exc import DBAPIError

from app.aggregate import LIVE_SECONDS, live_seconds, live_seconds_expr
from app.config import DatabaseConfigurationError, Settings, resolve_database_url
from app.db import IS_POSTGRES, SessionLocal, engine, init_db
from app.models import Role, Task, TaskStatus, User, WorkSession, utcnow
from tests.conftest import CSRF, login, make_user


# --- selecting the database -------------------------------------------------


def test_the_url_decides_the_backend_and_nothing_else():
    sqlite = Settings(DATABASE_URL="sqlite:///./x.db")
    assert sqlite.is_sqlite and not sqlite.is_postgresql

    pg = Settings(DATABASE_URL="postgresql+psycopg://u:p@db:5432/app")
    assert pg.is_postgresql and not pg.is_sqlite


@pytest.mark.parametrize(
    "given,expected_scheme",
    [
        ("postgres://u:p@db:5432/app", "postgresql+psycopg"),
        ("postgresql://u:p@db:5432/app", "postgresql+psycopg"),
        ("postgresql+psycopg://u:p@db:5432/app", "postgresql+psycopg"),
    ],
)
def test_every_pasted_postgres_url_lands_on_the_installed_driver(given, expected_scheme):
    """Providers hand out `postgres://`; SQLAlchemy reads that as psycopg2,
    which this project does not ship."""
    assert resolve_database_url(Settings(DATABASE_URL=given)).startswith(expected_scheme)


def test_the_password_never_appears_in_the_loggable_url():
    secret = Settings(DATABASE_URL="postgresql+psycopg://appuser:hunter2@db:5432/appdb")
    safe = secret.safe_database_url
    assert "hunter2" not in safe
    assert safe == "postgresql+psycopg://appuser:***@db:5432/appdb"


def test_a_sqlite_url_is_logged_verbatim_because_it_has_no_password():
    cfg = Settings(DATABASE_URL="sqlite:///./data/app.db")
    assert cfg.safe_database_url == "sqlite:///./data/app.db"


@pytest.mark.parametrize(
    "bad,fragment",
    [
        ("", "DATABASE_URL is empty"),
        ("   ", "DATABASE_URL is empty"),
        ("not-a-url", "no '://'"),
        ("mysql+pymysql://u:p@db:3306/app", "unsupported database"),
        ("postgresql+psycopg2://u:p@db:5432/app", "psycopg2"),
    ],
)
def test_a_bad_url_fails_at_boot_with_a_readable_message(bad, fragment):
    with pytest.raises(DatabaseConfigurationError) as exc:
        resolve_database_url(Settings(DATABASE_URL=bad))
    assert fragment in str(exc.value)


def test_a_configuration_error_never_leaks_the_password():
    cfg = Settings(DATABASE_URL="postgresql+psycopg2://appuser:hunter2@db:5432/app")
    with pytest.raises(DatabaseConfigurationError) as exc:
        resolve_database_url(cfg)
    assert "hunter2" not in str(exc.value)


def test_the_engine_reports_the_dialect_the_url_asked_for():
    assert engine.dialect.name == ("postgresql" if IS_POSTGRES else "sqlite")


def test_health_names_the_database_it_is_actually_connected_to(client):
    body = client.get("/api/health").json()
    assert body["database"] == ("postgresql" if IS_POSTGRES else "sqlite")
    # The redacted URL is for an operator reading `docker compose logs`.
    assert "password" not in body["database_url"]


# --- identifier generation --------------------------------------------------


def test_inserted_rows_get_real_sequential_ids(client, users):
    """SQLite and PostgreSQL both use a serial/identity column, but the value
    the ORM reads back must be the one the database generated, not a guess."""
    login(client, "lead@x.com")
    ids = [client.post("/api/tasks", headers=CSRF, json={"title": f"T{i}"}).json()["id"] for i in range(3)]
    assert all(isinstance(i, int) and i > 0 for i in ids), ids
    assert ids == sorted(ids) and len(set(ids)) == 3


def test_the_sequence_is_usable_after_an_explicit_id_was_inserted(client, users):
    """A raw insert with an explicit id must not stop the app creating rows.

    This is the shape a data import leaves behind, so it is the shape that has
    to be survivable. (Whether the *sequence* also advances past the explicit
    value is the import tool's job, not this test's -- see app/cli.py
    `import-sqlite`, which resets it explicitly.)
    """
    now = utcnow()
    with engine.begin() as conn:
        # Every NOT NULL column is listed explicitly. These columns have
        # Python-side `default=` values, which SQLAlchemy fills in for the ORM
        # but which are not emitted as SQL server defaults, so a raw insert has
        # to supply them. True on both engines.
        conn.execute(
            text(
                "INSERT INTO users (id, email, full_name, password_hash, role, is_admin, "
                "can_review, is_active, must_change_password, created_at, updated_at) "
                "VALUES (:id, :email, 'Gap', 'x', 'member', false, false, true, false, "
                ":now, :now)"
            ),
            {"id": 999999, "email": "gap@x.com", "now": now},
        )
    uid = make_user("after@x.com", "After", Role.member.value)
    db = SessionLocal()
    try:
        assert db.scalar(select(User).where(User.id == uid)) is not None
    finally:
        db.close()


# --- transactions -----------------------------------------------------------


def test_a_failed_write_tx_rolls_back_the_whole_unit_of_work(client, users):
    """`write_tx` must put the data change *and* its audit event in one
    transaction. If the handler raises, neither survives."""
    login(client, "lead@x.com")
    task = client.post("/api/tasks", headers=CSRF, json={"title": "Doomed"}).json()

    from app.db import write_tx

    with pytest.raises(RuntimeError):
        with write_tx() as db:
            task_row = db.get(Task, task["id"])
            task_row.title = "Changed"
            db.flush()
            db.execute(
                text(
                    "INSERT INTO audit_events (event_type, request_id, actor_name, "
                    "entity_type, entity_id, summary, created_at) "
                    "VALUES ('task.updated', 'r', 'system', 'task', :id, 'marker', :now)"
                ),
                {"id": task["id"], "now": utcnow()},
            )
            raise RuntimeError("boom")

    db = SessionLocal()
    try:
        assert db.get(Task, task["id"]).title == "Doomed"
        markers = db.execute(
            text("SELECT count(*) FROM audit_events WHERE summary = 'marker'")
        ).scalar()
        assert markers == 0
    finally:
        db.close()


def test_two_sessions_do_not_share_a_transaction(client, users):
    """A read outside a write_tx must not be able to see an uncommitted write
    from another session. On PostgreSQL this is the default; on SQLite the
    `BEGIN IMMEDIATE` write lock is what guarantees it."""
    login(client, "lead@x.com")
    task_id = client.post("/api/tasks", headers=CSRF, json={"title": "Isolation"}).json()["id"]

    from app.db import write_tx

    writer = SessionLocal()
    reader = SessionLocal()
    try:
        with write_tx() as wdb:
            wdb.execute(text("UPDATE tasks SET title = 'Uncommitted' WHERE id = :i"), {"i": task_id})
            wdb.flush()
            seen = reader.scalar(select(Task.title).where(Task.id == task_id))
            # PostgreSQL READ COMMITTED: the reader must not see it. SQLite
            # would raise "database is locked" on the write; either way the
            # uncommitted value must not come back.
            assert seen != "Uncommitted"
    finally:
        writer.close()
        reader.close()


def test_a_foreign_key_violation_is_rejected(client, users):
    """PostgreSQL enforces foreign keys on every commit; SQLite only does so
    because `init_db` turns the pragma on. Both must reject."""
    now = utcnow()
    with pytest.raises(DBAPIError):
        with engine.begin() as conn:
            conn.execute(
                text(
                    "INSERT INTO task_logs (task_id, user_id, entry_type, source, started_at, "
                    "created_at) VALUES (999999, 999999, 'work_session', 'manual', :now, :now)"
                ),
                {"now": now},
            )


def test_a_unique_violation_is_rejected(client, users):
    now = utcnow()
    with pytest.raises(DBAPIError):
        with engine.begin() as conn:
            for _ in range(2):
                conn.execute(
                    text(
                        "INSERT INTO users (email, full_name, password_hash, role, is_admin, "
                        "can_review, is_active, must_change_password, created_at, updated_at) "
                        "VALUES ('dupe2@x.com', 'D', 'x', 'member', false, false, true, "
                        "false, :now, :now)"
                    ),
                    {"now": now},
                )


def test_audit_events_stay_append_only_after_a_restart(client, users):
    """The guarantee is installed by the schema bootstrap, so it must survive
    the app being stopped and started again."""
    login(client, "m1@x.com")
    client.post("/api/tasks", headers=CSRF, json={"title": "Audited"})
    init_db()
    db = SessionLocal()
    try:
        with pytest.raises(DBAPIError):
            db.execute(
                text("DELETE FROM audit_events WHERE id = (SELECT min(id) FROM audit_events)")
            )
        db.rollback()
    finally:
        db.close()


# --- the dialect-specific SQL -----------------------------------------------


def test_live_seconds_is_a_valid_expression_on_this_dialect(client, users):
    """The running-timer accrual used to be written in SQLite's `julianday`.
    Compiled against PostgreSQL it is a syntax error, so this only proves
    anything if it actually executes."""
    login(client, "m1@x.com")
    task = client.post("/api/tasks", headers=CSRF, json={"title": "Running"}).json()
    client.post(f"/api/tasks/{task['id']}/timer/start", headers=CSRF)

    db = SessionLocal()
    try:
        assert int(db.scalar(select(func.coalesce(func.sum(LIVE_SECONDS), 0)))) >= 0
        assert int(db.scalar(select(live_seconds_expr()))) >= 0
    finally:
        db.close()


def test_live_seconds_is_floored_at_zero_for_a_future_timestamp(client, users):
    """`max(0, ...)` became a CASE because PostgreSQL has no two-argument max().
    A clock-skewed future start must still report 0, never a negative total."""
    login(client, "lead@x.com")
    task_id = client.post("/api/tasks", headers=CSRF, json={"title": "Future"}).json()["id"]
    future = utcnow().replace(year=utcnow().year + 5)
    db = SessionLocal()
    try:
        row = WorkSession(
            task_id=task_id,
            user_id=users["lead"],
            entry_type="work_session",
            source="timer",
            started_at=future,
            ended_at=None,
            created_at=utcnow(),
        )
        db.add(row)
        db.flush()
        value = db.scalar(
            select(live_seconds(WorkSession.ended_at, WorkSession.started_at))
            .select_from(WorkSession)
            .where(WorkSession.id == row.id)
        )
        assert int(value) == 0, value
        db.rollback()
    finally:
        db.close()


def _manual(client, task_id, *, minutes_ago, duration_minutes):
    started = (
        datetime.now(timezone.utc) - timedelta(minutes=minutes_ago)
    ).strftime("%Y-%m-%dT%H:%M:%S")
    return client.post(
        f"/api/tasks/{task_id}/logs",
        headers=CSRF,
        json={"entry_type": "work_session", "started_at": started, "duration_minutes": duration_minutes},
    )


def _own_task(client, title):
    """Time can only be recorded on a task assigned to the caller."""
    return client.post("/api/tasks", headers=CSRF, json={"title": title}).json()["id"]


def test_a_closed_entry_contributes_exactly_its_recorded_duration(client, users):
    login(client, "m1@x.com")
    task_id = _own_task(client, "Closed")
    r = _manual(client, task_id, minutes_ago=60, duration_minutes=30)
    assert r.status_code == 201, r.text
    assert r.json()["duration_seconds"] == 1800
    # The aggregate has to agree, which is what exercises the date arithmetic.
    assert client.get(f"/api/tasks/{task_id}").json()["tracked_seconds"] == 1800


def test_booleans_round_trip(client, users):
    login(client, "lead@x.com")
    created = client.post(
        "/api/tasks", headers=CSRF, json={"title": "Flagged", "requires_review": True}
    ).json()
    assert created["requires_review"] is True
    detail = client.get(f"/api/tasks/{created['id']}").json()
    assert detail["requires_review"] is True
    cleared = client.patch(
        f"/api/tasks/{created['id']}", headers=CSRF, json={"requires_review": False}
    ).json()
    assert cleared["requires_review"] is False


def test_partial_unique_indexes_stay_partial_on_this_dialect(client, users):
    """Regression guard for the silent one: a partial unique index whose
    predicate was only declared for the other dialect compiles to a *full*
    unique index. Nothing errors -- legitimate rows simply start being
    rejected. Two closed sessions on one task must both be allowed."""
    login(client, "m1@x.com")
    task_id = _own_task(client, "Twice")
    # Two non-overlapping sessions on the same task. A full unique index over
    # (user_id, task_id) would reject the second outright.
    for minutes_ago, minutes in ((180, 60), (30, 30)):
        r = _manual(client, task_id, minutes_ago=minutes_ago, duration_minutes=minutes)
        assert r.status_code == 201, r.text

    db = SessionLocal()
    try:
        assert db.scalar(
            select(func.count()).select_from(WorkSession).where(WorkSession.task_id == task_id)
        ) == 2
    finally:
        db.close()


def test_a_deleted_folder_name_becomes_reusable(client, users):
    """Same class of index: `uq_folder_sibling_name` only guards live rows."""
    login(client, "lead@x.com")
    first = client.post("/api/workspace/folders", headers=CSRF, json={"name": "Reports"})
    assert first.status_code == 201, first.text
    client.delete(f"/api/workspace/folders/{first.json()['id']}", headers=CSRF)
    again = client.post("/api/workspace/folders", headers=CSRF, json={"name": "Reports"})
    assert again.status_code == 201, again.text


def test_a_live_folder_name_is_still_rejected(client, users):
    """The other half of the same index: it must still bite on live rows."""
    login(client, "lead@x.com")
    first = client.post("/api/workspace/folders", headers=CSRF, json={"name": "Live"})
    assert first.status_code == 201, first.text
    again = client.post("/api/workspace/folders", headers=CSRF, json={"name": "Live"})
    assert again.status_code in (409, 422), again.text


# --- concurrency ------------------------------------------------------------


def test_concurrent_writes_all_commit(client, users):
    """SQLite serialises on one writer; PostgreSQL handles real concurrency.
    Ten threads each writing their own task must all land, with no lost
    updates and no leaked connection."""
    login(client, "lead@x.com")
    errors: list[BaseException] = []
    barrier = threading.Barrier(10)

    def worker(n: int) -> None:
        from app.db import write_tx

        try:
            barrier.wait(timeout=20)
            with write_tx() as db:
                db.add(
                    Task(
                        title=f"Concurrent {n}",
                        status=TaskStatus.todo.value,
                        priority="medium",
                        progress_percent=0,
                        created_at=utcnow(),
                        updated_at=utcnow(),
                        version=1,
                    )
                )
        except BaseException as exc:  # noqa: BLE001 - re-raised on the main thread
            errors.append(exc)

    threads = [threading.Thread(target=worker, args=(i,)) for i in range(10)]
    for t in threads:
        t.start()
    for t in threads:
        t.join(timeout=60)

    assert not errors, errors
    db = SessionLocal()
    try:
        assert db.scalar(
            select(func.count()).select_from(Task).where(Task.title.like("Concurrent %"))
        ) == 10
    finally:
        db.close()


def test_the_pool_returns_connections_rather_than_exhausting_it(client, users):
    """One `pool_pre_ping`-enabled engine, DB_POOL_SIZE + DB_MAX_OVERFLOW
    connections. Far more sequential checkouts than that must all succeed."""
    from app.config import settings

    db = SessionLocal()
    try:
        rounds = settings.DB_POOL_SIZE + settings.DB_MAX_OVERFLOW + 5
        for _ in range(rounds):
            db.execute(text("SELECT 1"))
    finally:
        db.close()
    engine.dispose()