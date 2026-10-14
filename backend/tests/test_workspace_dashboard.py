"""Gate suite: workspace permissions, dashboards, and the no-placeholder rule."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

from tests.conftest import CSRF, login


def code(r) -> str:
    return r.json()["detail"]["code"]


def utc(**kw) -> str:
    return (datetime.now(timezone.utc) + timedelta(**kw)).strftime("%Y-%m-%dT%H:%M:%S")


def task_for(client, **kw):
    payload = {"title": "Work item"}
    payload.update(kw)
    return client.post("/api/tasks", headers=CSRF, json=payload).json()


def log_time(client, tid, hours_ago, hours):
    return client.post(f"/api/tasks/{tid}/logs", headers=CSRF, json={
        "started_at": (datetime.now(timezone.utc) - timedelta(hours=hours_ago)).strftime("%Y-%m-%dT%H:%M:%S"),
        "ended_at": (datetime.now(timezone.utc) - timedelta(hours=hours_ago - hours)).strftime("%Y-%m-%dT%H:%M:%S"),
    })


# --- workspace -------------------------------------------------------------

def test_member_cannot_create_folders_by_default(client, users):
    login(client, "m1@x.com")
    r = client.post("/api/workspace/folders", headers=CSRF, json={"name": "Nope"})
    assert r.status_code == 403 and code(r) == "CANNOT_CREATE_FOLDERS"


def test_lead_can_nest_folders(client, users):
    login(client, "lead@x.com")
    top = client.post("/api/workspace/folders", headers=CSRF, json={"name": "Campaigns"}).json()
    child = client.post("/api/workspace/folders", headers=CSRF, json={"name": "Q1", "parent_id": top["id"]}).json()
    assert child["parent_id"] == top["id"] and child["depth"] == 2


def test_sibling_names_are_unique_case_insensitive(client, users):
    login(client, "lead@x.com")
    client.post("/api/workspace/folders", headers=CSRF, json={"name": "Campaigns"})
    r = client.post("/api/workspace/folders", headers=CSRF, json={"name": "campaigns"})
    assert r.status_code == 409 and code(r) == "DUPLICATE_FOLDER_NAME"


def test_folder_cannot_move_under_itself_or_a_descendant(client, users):
    login(client, "lead@x.com")
    a = client.post("/api/workspace/folders", headers=CSRF, json={"name": "A"}).json()
    b = client.post("/api/workspace/folders", headers=CSRF, json={"name": "B", "parent_id": a["id"]}).json()
    assert client.post(f"/api/workspace/folders/{a['id']}/move", headers=CSRF, json={"parent_id": a["id"]}).status_code == 422
    r = client.post(f"/api/workspace/folders/{a['id']}/move", headers=CSRF, json={"parent_id": b["id"]})
    assert r.status_code == 422 and code(r) == "FOLDER_CYCLE"


def test_management_visibility_is_hidden_from_members_as_404(client, users):
    login(client, "lead@x.com")
    secret = client.post("/api/workspace/folders", headers=CSRF, json={
        "name": "Board only", "visibility": "management",
    }).json()
    open_folder = client.post("/api/workspace/folders", headers=CSRF, json={"name": "Everyone"}).json()
    client.post("/api/workspace/links", headers=CSRF, json={
        "folder_id": secret["id"], "title": "Acquisition target", "url": "https://example.com/a",
    })
    client.post("/api/auth/logout", headers=CSRF)
    login(client, "m1@x.com")

    ids = [f["id"] for f in client.get("/api/workspace/folders").json()]
    assert secret["id"] not in ids and open_folder["id"] in ids
    assert client.get("/api/workspace/links").json() == []
    assert client.patch(f"/api/workspace/folders/{secret['id']}", headers=CSRF, json={"name": "x"}).status_code == 404


def test_management_visibility_cascades_to_descendants(client, users):
    login(client, "lead@x.com")
    parent = client.post("/api/workspace/folders", headers=CSRF, json={"name": "Parent"}).json()
    child = client.post("/api/workspace/folders", headers=CSRF, json={"name": "Child", "parent_id": parent["id"]}).json()
    client.patch(f"/api/workspace/folders/{parent['id']}", headers=CSRF, json={"visibility": "management"})
    folders = {f["id"]: f["visibility"] for f in client.get("/api/workspace/folders").json()}
    assert folders[parent["id"]] == "management" and folders[child["id"]] == "management"


def test_folder_delete_requires_empty(client, users):
    login(client, "lead@x.com")
    folder = client.post("/api/workspace/folders", headers=CSRF, json={"name": "Has links"}).json()
    client.post("/api/workspace/links", headers=CSRF, json={
        "folder_id": folder["id"], "title": "Ref", "url": "https://example.com/r",
    })
    r = client.delete(f"/api/workspace/folders/{folder['id']}", headers=CSRF)
    assert r.status_code == 409 and code(r) == "FOLDER_NOT_EMPTY"
    assert r.json()["detail"]["link_count"] == 1


def test_link_url_schemes(client, users):
    login(client, "m1@x.com")
    for bad in ["javascript:alert(1)", "data:text/html,x", "file:///etc/passwd", "ftp://x.com/f", "https://", "https://u:p@x.com/"]:
        r = client.post("/api/workspace/links", headers=CSRF, json={"title": "Bad", "url": bad})
        assert r.status_code == 422, bad
    ok = client.post("/api/workspace/links", headers=CSRF, json={"title": "Good", "url": "https://example.com/ok"})
    assert ok.status_code == 201


def test_member_owns_their_links_and_can_edit_them(client, users):
    login(client, "m1@x.com")
    mine = client.post("/api/workspace/links", headers=CSRF, json={"title": "Mine", "url": "https://example.com/m"}).json()
    client.post("/api/auth/logout", headers=CSRF)
    login(client, "m2@x.com")
    other = client.post("/api/workspace/links", headers=CSRF, json={"title": "Theirs", "url": "https://example.com/t"}).json()
    # m2 may edit its own link, but not m1's
    assert client.patch(f"/api/workspace/links/{other['id']}", headers=CSRF, json={"title": "Fine"}).status_code == 200
    assert client.patch(f"/api/workspace/links/{mine['id']}", headers=CSRF, json={"title": "Hijack"}).status_code == 403
    client.post("/api/auth/logout", headers=CSRF)
    login(client, "m1@x.com")
    assert client.patch(f"/api/workspace/links/{mine['id']}", headers=CSRF, json={"title": "Renamed"}).status_code == 200
    # a visible link the caller does not own is a 403 with a clear code
    r = client.patch(f"/api/workspace/links/{other['id']}", headers=CSRF, json={"title": "X"})
    assert r.status_code == 403 and code(r) == "CANNOT_EDIT_LINK"


def test_search_needs_two_characters_and_escapes_wildcards(client, users):
    login(client, "m1@x.com")
    client.post("/api/workspace/links", headers=CSRF, json={"title": "Brand guide", "url": "https://example.com/b"})
    assert client.get("/api/workspace/search", params={"q": "b"}).status_code == 422
    assert client.get("/api/workspace/search", params={"q": "brand"}).json()["links"]
    # a bare wildcard must not match everything
    assert client.get("/api/workspace/search", params={"q": "%%"}).json()["links"] == []


def test_tags_are_normalised(client, users):
    login(client, "m1@x.com")
    r = client.post("/api/workspace/links", headers=CSRF, json={
        "title": "Tagged", "url": "https://example.com/t", "tags": ["  Social Media ", "social media", "Q1"],
    }).json()
    assert r["tags"] == ["social media", "q1"]


# --- dashboards ------------------------------------------------------------

def test_member_cannot_see_executive_dashboard(client, users):
    login(client, "m1@x.com")
    assert client.get("/api/dashboard/executive").status_code == 403
    assert client.get("/api/dashboard/lead").status_code == 403
    assert client.get("/api/dashboard/personal").status_code == 200


def test_executive_dashboard_matches_independent_sql(client, users):
    from sqlalchemy import func, select

    from app.db import SessionLocal
    from app.models import Task, TaskStatus

    login(client, "lead@x.com")
    a = task_for(client, title="A", assignee_id=users["m1"], due_date="2020-01-01")
    b = task_for(client, title="B", assignee_id=users["m1"])
    c = task_for(client, title="C", assignee_id=users["m2"])
    client.post(f"/api/tasks/{c['id']}/status", headers=CSRF, json={"status": "blocked", "reason": "waiting"})
    own = task_for(client, title="Lead's own", assignee_id=users["lead"])
    log_time(client, own["id"], 3, 1)

    body = client.get("/api/dashboard/executive").json()
    db = SessionLocal()
    try:
        live = db.scalar(select(func.count()).select_from(Task).where(Task.deleted_at.is_(None)))
        overdue = db.scalar(select(func.count()).select_from(Task).where(
            Task.deleted_at.is_(None),
            Task.due_date.is_not(None),
            Task.status != TaskStatus.completed.value,
            Task.due_date < datetime.now(timezone.utc).date(),
        ))
        blocked = db.scalar(select(func.count()).select_from(Task).where(
            Task.deleted_at.is_(None), Task.status == TaskStatus.blocked.value
        ))
    finally:
        db.close()
    assert body["counts"]["total"] == live == 4
    assert body["counts"]["overdue"] == overdue == 1
    assert body["counts"]["by_status"]["blocked"] == blocked == 1
    assert body["counts"]["tracked_seconds"] == 3600


def test_executive_dashboard_shows_working_now(client, users):
    login(client, "lead@x.com")
    t = task_for(client, assignee_id=users["m1"])
    client.post("/api/auth/logout", headers=CSRF)
    login(client, "m1@x.com")
    client.post(f"/api/tasks/{t['id']}/timer/start", headers=CSRF)
    client.post("/api/auth/logout", headers=CSRF)
    login(client, "lead@x.com")
    working = client.get("/api/dashboard/executive").json()["working_now"]
    assert len(working) == 1
    assert working[0]["user"]["full_name"] == "Member One"
    assert working[0]["task"]["id"] == t["id"]


def test_deleted_tasks_leave_the_metrics(client, users):
    login(client, "lead@x.com")
    t = task_for(client, assignee_id=users["m1"])
    client.delete(f"/api/tasks/{t['id']}", headers=CSRF)
    body = client.get("/api/dashboard/executive").json()
    assert body["counts"]["total"] == 0


def test_member_workload_is_visible_but_never_ranked(client, users):
    login(client, "lead@x.com")
    task_for(client, assignee_id=users["m1"])
    task_for(client, assignee_id=users["m1"])
    task_for(client, assignee_id=users["m2"])
    members = client.get("/api/dashboard/executive").json()["members"]
    names = [m["user"]["full_name"] for m in members]
    assert names == sorted(names)  # ordered by name, never by hours or completions


def test_time_summary_is_self_only_for_members(client, users):
    login(client, "m1@x.com")
    assert client.get("/api/dashboard/time-summary", params={"user_id": users["m2"]}).status_code == 403
    assert client.get("/api/dashboard/time-summary").status_code == 200


def test_kpi_links_resolve_to_a_filtered_task_list(client, users):
    login(client, "lead@x.com")
    t = task_for(client, assignee_id=users["m1"])
    client.post(f"/api/tasks/{t['id']}/status", headers=CSRF, json={"status": "blocked", "reason": "waiting on copy"})
    body = client.get("/api/dashboard/executive").json()
    assert body["counts"]["by_status"]["blocked"] == 1
    listed = client.get("/api/tasks", params={"status": "blocked"}).json()
    assert [i["id"] for i in listed["items"]] == [t["id"]]


def test_empty_state_has_no_placeholder_numbers(client, users):
    login(client, "lead@x.com")
    body = client.get("/api/dashboard/executive").json()
    assert body["counts"]["total"] == 0
    assert body["counts"]["tracked_seconds"] == 0
    assert body["working_now"] == []