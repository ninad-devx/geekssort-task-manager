"""Role powers are admin-configurable, and defaults never drift."""

from __future__ import annotations

from tests.conftest import CSRF, login


def _matrix(client):
    r = client.get("/api/permissions")
    assert r.status_code == 200, r.text
    return r.json()


def _role(client, name):
    return next(row for row in _matrix(client)["roles"] if row["role"] == name)


def _set(client, role, keys):
    return client.put(f"/api/permissions/{role}", headers=CSRF, json={"permissions": keys})


# --- defaults ---------------------------------------------------------------

def test_defaults_match_the_original_spec(client, users):
    login(client, "ceo@x.com")
    caps = client.get("/api/auth/me").json()["capabilities"]
    # 7.2: a CEO creates no tasks and adds no links
    assert caps["can_create_tasks"] is False
    assert caps["can_add_links"] is False
    assert caps["can_view_team"] is True

    login(client, "m1@x.com")
    caps = client.get("/api/auth/me").json()["capabilities"]
    assert caps["can_create_tasks"] is True
    assert caps["can_view_team"] is False
    assert caps["can_manage_users"] is False


def test_matrix_reports_every_permission_key(client, users):
    login(client, "lead@x.com")
    rows = _matrix(client)["permissions"]
    keys = {row["key"] for row in rows}
    assert {"create_tasks", "view_team_tasks", "edit_any_task", "track_time"} <= keys
    assert all(row["label"] for row in rows)


def test_roles_start_on_defaults(client, users):
    login(client, "lead@x.com")
    assert _role(client, "ceo")["is_default"] is True
    assert _role(client, "team_lead")["is_default"] is True
    assert _role(client, "member")["is_default"] is True


# --- admin control ----------------------------------------------------------

def test_non_admin_cannot_read_the_matrix(client, users):
    login(client, "m1@x.com")
    assert client.get("/api/permissions").status_code == 403


def test_non_admin_cannot_change_permissions(client, users):
    login(client, "m2@x.com")
    assert _set(client, "ceo", []).status_code == 403


def test_admin_can_give_a_ceo_every_power(client, users):
    login(client, "lead@x.com")
    everything = [row["key"] for row in _matrix(client)["permissions"]]
    assert _set(client, "ceo", everything).status_code == 200

    login(client, "ceo@x.com")
    caps = client.get("/api/auth/me").json()["capabilities"]
    assert caps["can_create_tasks"] is True
    assert caps["can_add_links"] is True
    assert caps["can_create_folders"] is True


def test_granted_powers_take_effect_without_relogin(client, users):
    login(client, "ceo@x.com")
    denied = client.post("/api/tasks", headers=CSRF, json={"title": "Not allowed"})
    assert denied.status_code == 403

    login(client, "lead@x.com")
    assert _set(client, "ceo", ["create_tasks"]).status_code == 200

    login(client, "ceo@x.com")
    allowed = client.post("/api/tasks", headers=CSRF, json={"title": "Now allowed"})
    assert allowed.status_code == 201, allowed.text


def test_revoking_a_permission_takes_effect_on_the_next_request(client, users):
    login(client, "lead@x.com")
    assert _set(client, "member", ["create_tasks", "change_status_assigned"]).status_code == 200

    login(client, "m1@x.com")
    task = client.post("/api/tasks", headers=CSRF, json={"title": "Mine"}).json()
    ok = client.post(f"/api/tasks/{task['id']}/status", headers=CSRF, json={"status": "in_progress"})
    assert ok.status_code == 200, ok.text

    login(client, "lead@x.com")
    assert _set(client, "member", ["create_tasks"]).status_code == 200

    login(client, "m1@x.com")
    blocked = client.post(f"/api/tasks/{task['id']}/status", headers=CSRF, json={"status": "completed"})
    assert blocked.status_code == 403


def test_unknown_permission_is_rejected(client, users):
    login(client, "lead@x.com")
    r = _set(client, "ceo", ["create_tasks", "become_the_boss"])
    assert r.status_code == 422
    assert "become_the_boss" in str(r.json())


def test_reset_restores_defaults(client, users):
    login(client, "lead@x.com")
    _set(client, "ceo", ["create_tasks"])
    assert "create_tasks" in _role(client, "ceo")["permissions"]

    r = client.delete("/api/permissions/ceo", headers=CSRF)
    assert r.status_code == 200
    row = _role(client, "ceo")
    assert row["is_default"] is True
    assert row["permissions"] == sorted(row["defaults"])
    assert "create_tasks" not in row["permissions"]


def test_member_losing_track_time_cannot_start_a_timer(client, users):
    login(client, "m1@x.com")
    task = client.post("/api/tasks", headers=CSRF, json={"title": "Timed"}).json()
    assert client.post(f"/api/tasks/{task['id']}/timer/start", headers=CSRF).status_code == 200

    login(client, "lead@x.com")
    assert _set(client, "member", ["create_tasks"]).status_code == 200

    login(client, "m2@x.com")
    task2 = client.post("/api/tasks", headers=CSRF, json={"title": "Timed two"}).json()
    denied = client.post(f"/api/tasks/{task2['id']}/timer/start", headers=CSRF)
    assert denied.status_code == 403


def test_reassign_power_is_independent_of_view_team(client, users):
    login(client, "lead@x.com")
    task = client.post("/api/tasks", headers=CSRF, json={"title": "Hand off"}).json()
    moved = client.post(
        f"/api/tasks/{task['id']}/assign", headers=CSRF, json={"assignee_id": users["m1"]}
    )
    assert moved.status_code == 200, moved.text

    login(client, "m2@x.com")
    task2 = client.post("/api/tasks", headers=CSRF, json={"title": "Own"}).json()
    refused = client.post(
        f"/api/tasks/{task2['id']}/assign", headers=CSRF, json={"assignee_id": users["m1"]}
    )
    assert refused.status_code == 403


def test_permission_change_is_audited(client, users):
    login(client, "lead@x.com")
    _set(client, "ceo", ["create_tasks"])
    events = client.get("/api/audit?limit=100").json()["items"]
    kinds = [e["event_type"] for e in events]
    assert "role.permissions_updated" in kinds


def test_admin_flag_is_independent_of_the_role_matrix(client, users):
    # Stripping a role of every power does not touch the admin flag, so an
    # admin cannot accidentally lose user management by editing permissions.
    login(client, "lead@x.com")
    assert _set(client, "team_lead", []).status_code == 200

    caps = client.get("/api/auth/me").json()["capabilities"]
    assert caps["can_view_team"] is False
    assert caps["can_manage_users"] is True