"""Gate suite: auth, authorization, timers, overrides, audit immutability."""

from __future__ import annotations

import sqlite3

from app.db import SessionLocal
from tests.conftest import CSRF, login, make_user


def code(response) -> str:
    return response.json()["detail"]["code"]


# --- auth ------------------------------------------------------------------

def test_login_and_me(client, users):
    r = login(client, "lead@x.com")
    assert r.status_code == 200
    body = r.json()
    assert body["user"]["role"] == "team_lead"
    assert body["capabilities"]["can_manage_users"] is True
    assert client.get("/api/auth/me").status_code == 200


def test_unknown_email_and_wrong_password_are_identical(client, users):
    a = login(client, "nobody@x.com")
    b = login(client, "lead@x.com", "wrongpassword")
    assert a.status_code == 401 and b.status_code == 401
    assert code(a) == code(b) == "INVALID_CREDENTIALS"


def test_inactive_account_is_indistinguishable(client, users):
    make_user("gone@x.com", "Gone", "member", active=False)
    r = login(client, "gone@x.com")
    assert r.status_code == 401 and code(r) == "INVALID_CREDENTIALS"


def test_not_logged_in_is_401(client, users):
    assert client.get("/api/tasks").status_code == 401


def test_email_is_lowercased_and_unique(client, users):
    r = login(client, "LEAD@X.COM")
    assert r.status_code == 200
    assert r.json()["user"]["email"] == "lead@x.com"
    r = client.post("/api/users", headers=CSRF, json={"email": "lead@x.com", "full_name": "Dup", "role": "member"})
    assert r.status_code == 409 and code(r) == "EMAIL_TAKEN"


def test_logout_clears_session(client, users):
    login(client, "lead@x.com")
    assert client.post("/api/auth/logout", headers=CSRF).status_code == 204
    assert client.get("/api/auth/me").status_code == 401


def test_write_requires_csrf_header(client, users):
    login(client, "lead@x.com")
    assert client.post("/api/tasks", json={"title": "No CSRF header"}).status_code == 403
    assert client.post("/api/tasks", headers=CSRF, json={"title": "With CSRF"}).status_code == 201


def _write(client, origin, forwarded_host=None, host="127.0.0.1:8000"):
    """A write as the production chain delivers it.

    Next.js proxies the rewrite upstream with `changeOrigin: true`, so `Host`
    arrives as the API's own address and the browser's hostname survives only in
    `X-Forwarded-Host`. Reproducing that is what caught the original defect.
    """
    headers = dict(CSRF, Host=host, Origin=origin)
    if forwarded_host is not None:
        headers["X-Forwarded-Host"] = forwarded_host
    return client.post("/api/tasks", headers=headers, json={"title": "T"})


def test_write_survives_the_proxied_origin(client, users):
    login(client, "lead@x.com")
    assert _write(client, "https://app.example.com", "app.example.com").status_code == 201


def test_write_accepts_the_default_port_on_either_side(client, users):
    login(client, "lead@x.com")
    # RFC 6454: https://a.example and https://a.example:443 are one origin.
    assert _write(client, "https://app.example.com:443", "app.example.com").status_code == 201
    assert _write(client, "https://app.example.com", "app.example.com:443").status_code == 201


def test_write_accepts_a_non_default_port_when_the_proxy_keeps_it(client, users):
    login(client, "lead@x.com")
    r = _write(client, "https://app.example.com:8443", "app.example.com:8443")
    assert r.status_code == 201


def test_write_still_rejects_a_foreign_origin(client, users):
    login(client, "lead@x.com")
    r = _write(client, "https://evil.example", "app.example.com")
    assert r.status_code == 403 and code(r) == "ORIGIN_NOT_ALLOWED"


def test_write_rejects_a_same_host_port_mismatch(client, users):
    login(client, "lead@x.com")
    # A non-default port is a different origin and `Host` cannot vouch for it.
    r = _write(client, "https://app.example.com:8443", "app.example.com")
    assert r.status_code == 403 and code(r) == "ORIGIN_NOT_ALLOWED"


def test_write_rejects_a_null_origin(client, users):
    login(client, "lead@x.com")
    r = _write(client, "null", "app.example.com")
    assert r.status_code == 403 and code(r) == "ORIGIN_NOT_ALLOWED"


def test_write_uses_the_client_facing_entry_of_a_chained_forwarded_host(client, users):
    login(client, "lead@x.com")
    # nginx appends; the client-facing value is the first one.
    assert _write(client, "https://app.example.com", "app.example.com, inner:8000").status_code == 201


def test_origin_allowlist_still_short_circuits_the_check(client, users):
    login(client, "lead@x.com")
    assert _write(client, "http://localhost:3000", forwarded_host=None).status_code == 201


def test_must_change_password_blocks_everything_else(client):
    uid = make_user("tmp@x.com", "Temp", "member")
    db = SessionLocal()
    db.get(User, uid).must_change_password = True
    db.commit()
    db.close()
    login(client, "tmp@x.com")
    assert client.get("/api/auth/me").status_code == 200
    assert client.get("/api/tasks").status_code == 403
    assert code(client.get("/api/tasks")) == "PASSWORD_CHANGE_REQUIRED"
    assert client.post("/api/auth/change-password", headers=CSRF, json={
        "current_password": "Str0ngPassphrase!", "new_password": "AnotherLongPass1"
    }).status_code == 204
    assert client.get("/api/tasks").status_code == 200


def test_password_change_revokes_other_sessions(client, users):
    """FR-AUTH-008: all *other* sessions die; the one used for the change survives."""
    from fastapi.testclient import TestClient

    from app.main import app

    login(client, "m1@x.com")
    other = TestClient(app)
    assert other.post("/api/auth/login", json={"email": "m1@x.com", "password": "Str0ngPassphrase!"}).status_code == 200
    assert other.get("/api/auth/me").status_code == 200

    r = client.post("/api/auth/change-password", headers=CSRF, json={
        "current_password": "Str0ngPassphrase!", "new_password": "AnotherLongPass1"
    })
    assert r.status_code == 204
    assert client.get("/api/auth/me").status_code == 200   # current session survives
    assert other.get("/api/auth/me").status_code == 401    # other session revoked


def test_password_policy(client):
    make_user("longemail@x.com", "Long", "member")
    login(client, "longemail@x.com")
    # too short
    assert client.post("/api/auth/change-password", headers=CSRF, json={
        "current_password": "Str0ngPassphrase!", "new_password": "short"
    }).status_code == 422
    # equal to the email
    assert client.post("/api/auth/change-password", headers=CSRF, json={
        "current_password": "Str0ngPassphrase!", "new_password": "longemail@x.com"
    }).status_code == 422
    # correct current password is still required
    assert client.post("/api/auth/change-password", headers=CSRF, json={
        "current_password": "notmine-at-all", "new_password": "AnotherLongPass1"
    }).status_code == 401
    # a valid password is accepted
    assert client.post("/api/auth/change-password", headers=CSRF, json={
        "current_password": "Str0ngPassphrase!", "new_password": "AnotherLongPass1"
    }).status_code == 204


def test_rate_limit_after_five_failures(client, users):
    for _ in range(5):
        assert login(client, "m1@x.com", "wrong").status_code == 401
    r = login(client, "m1@x.com")
    assert r.status_code == 401 and code(r) == "TOO_MANY_ATTEMPTS"


from app.models import User  # noqa: E402


# --- users -----------------------------------------------------------------

def test_only_admin_can_manage_users(client, users):
    login(client, "m1@x.com")
    assert client.get("/api/users").status_code == 403
    assert client.post("/api/users", headers=CSRF, json={"email": "x@y.com", "full_name": "X", "role": "member"}).status_code == 403


def test_directory_never_exposes_email(client, users):
    login(client, "m1@x.com")
    rows = client.get("/api/users/directory").json()
    assert rows and all("email" not in r for r in rows)


def test_admin_cannot_change_own_role(client, users):
    login(client, "lead@x.com")
    me = client.get("/api/auth/me").json()["user"]
    r = client.patch(f"/api/users/{me['id']}", headers=CSRF, json={"role": "member"})
    assert r.status_code == 409


def test_temporary_password_shown_once_and_forces_change(client, users):
    login(client, "lead@x.com")
    r = client.post("/api/users", headers=CSRF, json={"email": "new@x.com", "full_name": "New", "role": "member"})
    assert r.status_code == 201
    body = r.json()
    assert body["temporary_password"] and body["must_change_password"] is True


def test_last_admin_cannot_be_demoted(client, users):
    login(client, "lead@x.com")
    me = client.get("/api/auth/me").json()["user"]["id"]
    r = client.patch(f"/api/users/{me}", headers=CSRF, json={"is_admin": False})
    assert r.status_code == 409 and code(r) == "LAST_ADMIN"


def test_deactivate_without_reassignment_returns_409(client, users):
    login(client, "lead@x.com")
    t = client.post("/api/tasks", headers=CSRF, json={"title": "T", "assignee_id": users["m1"]}).json()
    r = client.post(f"/api/users/{users['m1']}/deactivate", headers=CSRF, json={})
    assert r.status_code == 409 and code(r) == "HAS_OPEN_TASKS"
    assert r.json()["detail"]["open_task_count"] == 1
    assert t["assignee_id"] == users["m1"]


def test_deactivate_with_reassignment_moves_tasks_and_revokes_sessions(client, users):
    from fastapi.testclient import TestClient

    from app.main import app

    member_client = TestClient(app)
    assert member_client.post(
        "/api/auth/login", json={"email": "m1@x.com", "password": "Str0ngPassphrase!"}
    ).status_code == 200
    member_client.post(
        "/api/tasks", headers=CSRF, json={"title": "Mine", "assignee_id": users["m1"]}
    )

    login(client, "lead@x.com")
    r = client.post(
        f"/api/users/{users['m1']}/deactivate",
        headers=CSRF,
        json={"reassign_to_user_id": users["m2"]},
    )
    assert r.status_code == 200 and r.json()["is_active"] is False

    tasks = client.get("/api/tasks").json()["items"]
    assert tasks[0]["assignee_id"] == users["m2"]

    # the deactivated user's existing session is dead immediately
    assert member_client.get("/api/auth/me").status_code == 401
    # and they cannot sign in again
    assert member_client.post(
        "/api/auth/login", json={"email": "m1@x.com", "password": "Str0ngPassphrase!"}
    ).status_code == 401