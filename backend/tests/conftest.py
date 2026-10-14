from __future__ import annotations

import os
import tempfile
from pathlib import Path

import pytest

TMP = Path(tempfile.mkdtemp(prefix="mos-test-"))
os.environ["DATABASE_URL"] = f"sqlite:///{TMP / 'test.db'}"
os.environ["COOKIE_SECURE"] = "false"
os.environ["APP_TIMEZONE"] = "UTC"

from fastapi.testclient import TestClient  # noqa: E402

from app.db import SessionLocal, engine, init_db  # noqa: E402
from app.main import app  # noqa: E402
from app.models import User, Role, utcnow  # noqa: E402
from app.security import hash_password  # noqa: E402

CSRF = {"X-Requested-With": "marketingos"}


@pytest.fixture()
def client():
    from app.routers import auth as auth_router

    Base = __import__("app.models", fromlist=["Base"]).Base
    Base.metadata.drop_all(bind=engine)
    init_db()
    auth_router._failures.clear()  # in-memory rate-limit state must not leak between tests
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