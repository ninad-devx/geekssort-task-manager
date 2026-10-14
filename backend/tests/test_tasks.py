"""Gate suite: tasks, field-level permissions, state machine, visibility by 404."""

from __future__ import annotations

from tests.conftest import CSRF, login


def code(r) -> str:
    return r.json()["detail"]["code"]


def make_task(client, **kw):
    payload = {"title": "T"}
    payload.update(kw)
    return client.post("/api/tasks", headers=CSRF, json=payload)


# --- create ----------------------------------------------------------------

def test_ceo_cannot_create_tasks(client, users):
    login(client, "ceo@x.com")
    r = make_task(client, assignee_id=users["m1"])
    assert r.status_code == 403


def test_member_assignee_is_forced_to_self(client, users):
    login(client, "m1@x.com")
    r = make_task(client, title="Self", assignee_id=users["m2"])
    assert r.status_code == 403 and code(r) == "CANNOT_ASSIGN_OTHERS"
    r = make_task(client, title="Self2", assignee_id=users["m1"])
    assert r.status_code == 201 and r.json()["assignee_id"] == users["m1"]


def test_defaults(client, users):
    login(client, "lead@x.com")
    t = make_task(client, assignee_id=users["m1"]).json()
    assert t["status"] == "todo" and t["priority"] == "medium"
    assert t["progress_percent"] == 0 and t["requires_review"] is False
    assert t["version"] == 1 and t["tracked_seconds"] == 0


def test_validation(client, users):
    login(client, "lead@x.com")
    assert make_task(client, title="").status_code == 422
    assert make_task(client, title="x" * 201).status_code == 422
    assert make_task(client, estimated_minutes=0).status_code == 422
    assert make_task(client, estimated_minutes=100001).status_code == 422
    assert make_task(client, evidence_url="javascript:alert(1)").status_code in (201, 422)


# --- visibility ------------------------------------------------------------

def test_member_sees_only_own_tasks(client, users):
    login(client, "lead@x.com")
    mine = make_task(client, title="Lead task", assignee_id=users["m1"]).json()
    login(client, "m1@x.com")
    client.post("/api/auth/logout", headers=CSRF)
    login(client, "m2@x.com")
    assert client.get("/api/tasks").json()["items"] == []
    assert client.get(f"/api/tasks/{mine['id']}").status_code == 404


def test_ceo_and_lead_see_everything(client, users):
    login(client, "lead@x.com")
    t = make_task(client, title="Lead task", assignee_id=users["m1"]).json()
    client.post("/api/auth/logout", headers=CSRF)
    login(client, "ceo@x.com")
    assert client.get(f"/api/tasks/{t['id']}").status_code == 200


def test_nonexistent_task_is_404(client, users):
    login(client, "lead@x.com")
    assert client.get("/api/tasks/999999").status_code == 404


# --- field-level permissions ----------------------------------------------

def test_member_cannot_edit_core_fields_of_assigned_task(client, users):
    login(client, "lead@x.com")
    t = make_task(client, title="Assigned", assignee_id=users["m1"]).json()
    client.post("/api/auth/logout", headers=CSRF)
    login(client, "m1@x.com")
    r = client.patch(f"/api/tasks/{t['id']}", headers=CSRF, json={"title": "Renamed", "due_date": "2026-12-01"})
    assert r.status_code == 403 and code(r) == "FIELD_NOT_ALLOWED"
    assert client.get(f"/api/tasks/{t['id']}").json()["title"] == "Assigned"  # nothing changed


def test_member_cannot_set_requires_review(client, users):
    login(client, "lead@x.com")
    t = make_task(client, title="Assigned", assignee_id=users["m1"]).json()
    client.post("/api/auth/logout", headers=CSRF)
    login(client, "m1@x.com")
    r = client.patch(f"/api/tasks/{t['id']}", headers=CSRF, json={"requires_review": True})
    assert r.status_code == 403 and code(r) == "FIELD_NOT_ALLOWED"


def test_member_can_edit_progress_of_assigned_task(client, users):
    login(client, "lead@x.com")
    t = make_task(client, title="Assigned", assignee_id=users["m1"]).json()
    client.post("/api/auth/logout", headers=CSRF)
    login(client, "m1@x.com")
    r = client.patch(f"/api/tasks/{t['id']}", headers=CSRF, json={
        "progress_percent": 40, "evidence_url": "https://example.com/x"
    })
    assert r.status_code == 200
    assert r.json()["progress_percent"] == 40


def test_member_can_edit_own_self_created_task(client, users):
    login(client, "m1@x.com")
    t = make_task(client, title="Mine").json()
    r = client.patch(f"/api/tasks/{t['id']}", headers=CSRF, json={"title": "Renamed", "priority": "high"})
    assert r.status_code == 200 and r.json()["title"] == "Renamed"


def test_stale_version_conflicts(client, users):
    login(client, "lead@x.com")
    t = make_task(client, assignee_id=users["m1"]).json()
    client.patch(f"/api/tasks/{t['id']}", headers=CSRF, json={"title": "A", "if_version": 1})
    r = client.patch(f"/api/tasks/{t['id']}", headers=CSRF, json={"title": "B", "if_version": 1})
    assert r.status_code == 409 and code(r) == "STALE_VERSION"


def test_noop_update_writes_nothing(client, users):
    login(client, "lead@x.com")
    t = make_task(client, title="Same", assignee_id=users["m1"]).json()
    before = len(client.get("/api/audit", params={"task_id": t["id"]}).json()["items"])
    r = client.patch(f"/api/tasks/{t['id']}", headers=CSRF, json={"title": "Same"})
    assert r.status_code == 200 and r.json()["version"] == t["version"]
    after = len(client.get("/api/audit", params={"task_id": t["id"]}).json()["items"])
    assert before == after


# --- state machine ---------------------------------------------------------

def status(client, tid, to, **kw):
    body = {"status": to}
    body.update(kw)
    return client.post(f"/api/tasks/{tid}/status", headers=CSRF, json=body)


def test_invalid_transition_is_409(client, users):
    login(client, "lead@x.com")
    t = make_task(client, assignee_id=users["m1"]).json()
    assert status(client, t["id"], "in_review").status_code == 409
    assert code(status(client, t["id"], "in_review")) == "INVALID_TRANSITION"


def test_blocked_requires_reason_and_clears_it(client, users):
    login(client, "lead@x.com")
    t = make_task(client, assignee_id=users["m1"]).json()
    assert status(client, t["id"], "blocked").status_code == 409
    assert code(status(client, t["id"], "blocked")) == "REASON_REQUIRED"
    r = status(client, t["id"], "blocked", reason="Waiting on brand assets")
    assert r.status_code == 200 and r.json()["blocked_reason"] == "Waiting on brand assets"
    r = status(client, t["id"], "todo")
    assert r.json()["blocked_reason"] is None


def test_completed_sets_timestamps_and_reopen_clears_them(client, users):
    login(client, "lead@x.com")
    t = make_task(client, assignee_id=users["m1"]).json()
    r = status(client, t["id"], "completed")
    assert r.json()["completed_at"] is not None and r.json()["progress_percent"] == 100
    r = status(client, t["id"], "in_progress", note="more work needed")
    assert r.json()["completed_at"] is None


def test_requires_review_blocks_member_completion(client, users):
    login(client, "lead@x.com")
    t = make_task(client, assignee_id=users["m1"], requires_review=True).json()
    client.post("/api/auth/logout", headers=CSRF)
    login(client, "m1@x.com")
    r = status(client, t["id"], "completed")
    assert r.status_code == 403 and code(r) == "REVIEW_REQUIRED"


def test_reviewer_can_approve_and_request_revision(client, users):
    login(client, "lead@x.com")
    t = make_task(client, assignee_id=users["m1"], requires_review=True).json()
    status(client, t["id"], "in_progress")
    status(client, t["id"], "in_review")
    r = status(client, t["id"], "in_progress", note="Tighten the headline")
    assert r.status_code == 200
    events = client.get("/api/audit", params={"task_id": t["id"]}).json()["items"]
    assert any(e["event_type"] == "task.revision_requested" for e in events)


def test_transition_emits_exactly_one_event(client, users):
    login(client, "lead@x.com")
    t = make_task(client, assignee_id=users["m1"]).json()
    base = len(client.get("/api/audit", params={"task_id": t["id"]}).json()["items"])
    status(client, t["id"], "in_progress")
    after = len(client.get("/api/audit", params={"task_id": t["id"]}).json()["items"])
    assert after - base == 1


def test_ceo_cannot_change_status_except_review(client, users):
    login(client, "lead@x.com")
    t = make_task(client, assignee_id=users["m1"]).json()
    client.post("/api/auth/logout", headers=CSRF)
    login(client, "ceo@x.com")
    r = status(client, t["id"], "in_progress")
    assert r.status_code == 403


# --- reassign / delete / restore ------------------------------------------

def test_only_lead_can_reassign(client, users):
    login(client, "lead@x.com")
    t = make_task(client, assignee_id=users["m1"]).json()
    client.post("/api/auth/logout", headers=CSRF)
    login(client, "m1@x.com")
    r = client.post(f"/api/tasks/{t['id']}/assign", headers=CSRF, json={"assignee_id": users["m2"]})
    assert r.status_code == 403
    client.post("/api/auth/logout", headers=CSRF)
    login(client, "lead@x.com")
    r = client.post(f"/api/tasks/{t['id']}/assign", headers=CSRF, json={"assignee_id": users["m2"]})
    assert r.status_code == 200 and r.json()["assignee_id"] == users["m2"]


def test_reassign_rejects_inactive_user(client, users):
    login(client, "lead@x.com")
    t = make_task(client, assignee_id=users["m1"]).json()
    make_user_inactive(client, users["m2"])
    r = client.post(f"/api/tasks/{t['id']}/assign", headers=CSRF, json={"assignee_id": users["m2"]})
    assert r.status_code == 422


def make_user_inactive(client, user_id):
    return client.patch(f"/api/users/{user_id}", headers=CSRF, json={"is_active": False})


def test_soft_delete_and_restore(client, users):
    login(client, "lead@x.com")
    t = make_task(client, assignee_id=users["m1"]).json()
    assert client.delete(f"/api/tasks/{t['id']}", headers=CSRF).status_code == 200
    assert client.get("/api/tasks").json()["items"] == []
    assert client.get("/api/tasks", params={"include_deleted": True}).json()["total"] == 1
    assert client.post(f"/api/tasks/{t['id']}/restore", headers=CSRF).status_code == 200
    assert client.get("/api/tasks").json()["total"] == 1


def test_member_cannot_delete_assigned_task_but_can_delete_own(client, users):
    login(client, "lead@x.com")
    assigned = make_task(client, assignee_id=users["m1"]).json()
    client.post("/api/auth/logout", headers=CSRF)
    login(client, "m1@x.com")
    assert client.delete(f"/api/tasks/{assigned['id']}", headers=CSRF).status_code == 403
    own = make_task(client, title="Own").json()
    assert client.delete(f"/api/tasks/{own['id']}", headers=CSRF).status_code == 200


def test_member_cannot_restore(client, users):
    """Restore is a lead-only endpoint capability (7.2), so it is 403, not an object 404."""
    login(client, "lead@x.com")
    t = make_task(client, assignee_id=users["m1"]).json()
    client.delete(f"/api/tasks/{t['id']}", headers=CSRF)
    client.post("/api/auth/logout", headers=CSRF)
    login(client, "m1@x.com")
    r = client.post(f"/api/tasks/{t['id']}/restore", headers=CSRF)
    assert r.status_code == 403 and code(r) == "LEAD_ONLY"
    # and the member cannot even see the deleted task
    assert client.get(f"/api/tasks/{t['id']}").status_code == 404


def test_overdue_flag(client, users):
    login(client, "lead@x.com")
    overdue = make_task(client, assignee_id=users["m1"], due_date="2020-01-01").json()
    future = make_task(client, assignee_id=users["m1"], due_date="2099-01-01").json()
    assert overdue["is_overdue"] is True and future["is_overdue"] is False
    filtered = client.get("/api/tasks", params={"overdue": True}).json()
    assert [t["id"] for t in filtered["items"]] == [overdue["id"]]


def test_filters_and_pagination(client, users):
    login(client, "lead@x.com")
    for i in range(5):
        make_task(client, title=f"Task {i}", assignee_id=users["m1"], priority="high" if i < 2 else "low")
    make_task(client, title="Other", assignee_id=users["m2"], priority="low")
    assert client.get("/api/tasks", params={"priority": "high"}).json()["total"] == 2
    assert client.get("/api/tasks", params={"assignee_id": users["m2"]}).json()["total"] == 1
    assert client.get("/api/tasks", params={"q": "Task"}).json()["total"] == 5
    page = client.get("/api/tasks", params={"page": 1, "page_size": 2}).json()
    assert len(page["items"]) == 2 and page["total"] == 6
    assert client.get("/api/tasks", params={"page_size": 500}).status_code == 422


from tests.conftest import make_user  # noqa: E402