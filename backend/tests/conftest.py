from __future__ import annotations

import os
import tempfile
import uuid
from pathlib import Path
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

import pytest

TMP = Path(tempfile.mkdtemp(prefix="mos-test-"))

# Where the suite runs. Unset (the default) means the SQLite file below, which is
# what every existing developer workflow and every existing test expects.
#
# Set MOS_TEST_DATABASE_URL to run the identical suite against a real
# PostgreSQL, e.g.
#   MOS_TEST_DATABASE_URL=postgresql+psycopg://postgres:postgres@localhost:5432/mos_test
#
# Two guards make that safe to point at a shared server:
#   * the database name must look disposable (contains "test"), and
#   * every table lives in a throwaway schema created for this run and dropped
#     at the end, so the rest of the database is untouched even if the name
#     check is fooled.
TEST_POSTGRES_URL = os.environ.get("MOS_TEST_DATABASE_URL", "").strip()

if TEST_POSTGRES_URL:
    _parts = urlsplit(TEST_POSTGRES_URL)
    _dbname = _parts.path.lstrip("/")
    if "test" not in _dbname.lower():
        raise RuntimeError(
            f"MOS_TEST_DATABASE_URL points at database {_dbname!r}, which does not "
            f"look like a disposable test database (its name must contain 'test'). "
            f"Refusing to run -- this suite drops and recreates its schema on every "
            f"test. Create a dedicated database first, e.g. "
            f"'createdb mos_test'."
        )
    _SCHEMA = os.environ.get("MOS_TEST_PG_SCHEMA", "").strip() or f"mos_test_{uuid.uuid4().hex[:10]}"
    # search_path rides on the connection string so that *every* pooled
    # connection resolves unqualified names into the throwaway schema --
    # including the ones create_all and the init_db repair pass open for
    # themselves.
    _query = dict(parse_qsl(_parts.query))
    _query["options"] = f"-c search_path={_SCHEMA}"
    os.environ["DATABASE_URL"] = urlunsplit(
        (_parts.scheme, _parts.netloc, _parts.path, urlencode(_query), _parts.fragment)
    )
else:
    _SCHEMA = None
    os.environ["DATABASE_URL"] = f"sqlite:///{TMP / 'test.db'}"

os.environ["COOKIE_SECURE"] = "false"
os.environ["APP_TIMEZONE"] = "UTC"

from fastapi.testclient import TestClient  # noqa: E402
from sqlalchemy import text  # noqa: E402

from app.db import IS_POSTGRES, SessionLocal, engine, init_db  # noqa: E402
from app.main import app  # noqa: E402
from app.models import User, Role, utcnow  # noqa: E402
from app.security import hash_password  # noqa: E402

CSRF = {"X-Requested-With": "marketingos"}


def pytest_report_header(config):
    if IS_POSTGRES:
        return f"database: PostgreSQL (test schema {_SCHEMA!r})"
    return f"database: SQLite ({engine.url})"


@pytest.fixture(scope="session", autouse=True)
def _test_schema():
    """Create the throwaway PostgreSQL schema once, drop it when the run ends."""
    if not IS_POSTGRES:
        yield
        return
    with engine.connect() as conn:
        conn.execute(text(f'CREATE SCHEMA "{_SCHEMA}"'))
        conn.commit()
    try:
        yield
    finally:
        with engine.connect() as conn:
            conn.execute(text(f'DROP SCHEMA IF EXISTS "{_SCHEMA}" CASCADE'))
            conn.commit()


@pytest.fixture()
def client(_test_schema):
    from app.routers import auth as auth_router

    Base = __import__("app.models", fromlist=["Base"]).Base
    Base.metadata.drop_all(bind=engine)
    init_db()
    # Login throttling now lives in `login_attempts`, which the schema reset
    # above already clears.
    with TestClient(app) as c:
        yield c
    Base.metadata.drop_all(bind=engine)


def make_user(email, name, role, *, admin=False, review=False, active=True, password="Str0ngPassphrase!"):
    db = SessionLocal()
    try:
        u = User(
            email=email,
            full_name=name,
            password_hash=hash_password(password),
            role=role,
            is_admin=admin,
            can_review=review or role == Role.team_lead.value,
            is_active=active,
            must_change_password=False,
            created_at=utcnow(),
            updated_at=utcnow(),
        )
        db.add(u)
        db.commit()
        db.refresh(u)
        return u.id
    finally:
        db.close()


def login(client, email, password="Str0ngPassphrase!"):
    return client.post("/api/auth/login", json={"email": email, "password": password})


@pytest.fixture()
def users(client):
    return {
        "lead": make_user("lead@x.com", "Lead", Role.team_lead.value, admin=True),
        "ceo": make_user("ceo@x.com", "Ceo", Role.ceo.value, review=True),
        "m1": make_user("m1@x.com", "Member One", Role.member.value),
        "m2": make_user("m2@x.com", "Member Two", Role.member.value),
    }