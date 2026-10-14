"""Task-attached links stay on the task; the dashboard can show today."""

from __future__ import annotations

from datetime import date, timedelta

from tests.conftest import CSRF, login


def test_a_task_link_does_not_leak_into_the_workspace_list(client, users):
    """A link with no folder but a task belongs to the task, not the workspace."""
    login(client, "lead@x.com")
    task = client.post(
        "/api/tasks", headers=CSRF, json={"title": "Citations", "assignee_id": users["m1"]}
    ).json()
    client.post(
        "/api/workspace/links",
        headers=CSRF,
        json={"task_id": task["id"], "title": "Task only", "url": "https://example.com/a"},
    )
    client.post(
        "/api/workspace/links",
        headers=CSRF,
        json={"title": "Genuinely unfiled", "url": "https://example.com/b"},
    )

    workspace = client.get("/api/workspace/links").json()
    titles = [l["title"] for l in workspace]
    assert "Genuinely unfiled" in titles
    assert "Task only" not in titles, "a task link must not pollute the workspace"


def test_a_link_in_a_folder_still_appears_in_the_workspace(client, users):
    login(client, "lead@x.com")
    folder = client.post("/api/workspace/folders", headers=CSRF, json={"name": "Refs"}).json()
    client.post(
        "/api/workspace/links",
        headers=CSRF,
        json={
            "folder_id": folder["id"],
            "task_id": None,
            "title": "In a folder",
            "url": "https://example.com/c",
        },
    )
    titles = [l["title"] for l in client.get("/api/workspace/links").json()]
    assert "In a folder" in titles


def test_a_link_on_both_a_task_and_a_folder_shows_in_the_workspace(client, users):
    login(client, "lead@x.com")
    task = client.post("/api/tasks", headers=CSRF, json={"title": "T"}).json()
    folder = client.post("/api/workspace/folders", headers=CSRF, json={"name": "Refs"}).json()
    r = client.post(
        "/api/workspace/links",
        headers=CSRF,
        json={
            "task_id": task["id"],
            "folder_id": folder["id"],
            "title": "Both places",
            "url": "https://example.com/d",
        },
    ).json()
    assert r["task_id"] == task["id"] and r["folder_id"] == folder["id"]
    titles = [l["title"] for l in client.get("/api/workspace/links").json()]
    assert "Both places" in titles, "filed in a folder means it belongs in the workspace too"


def test_task_links_are_not_returned_by_workspace_search(client, users):
    login(client, "lead@x.com")
    task = client.post("/api/tasks", headers=CSRF, json={"title": "T"}).json()
    client.post(
        "/api/workspace/links",
        headers=CSRF,
        json={"task_id": task["id"], "title": "Zebracrossing", "url": "https://example.com/z"},
    )
    found = client.get("/api/workspace/search?q=zebracrossing").json()
    assert found["links"] == []


def test_the_task_link_is_still_reachable_from_the_task(client, users):
    login(client, "lead@x.com")
    task = client.post("/api/tasks", headers=CSRF, json={"title": "T"}).json()
    client.post(
        "/api/workspace/links",
        headers=CSRF,
        json={"task_id": task["id"], "title": "Task only", "url": "https://example.com/a"},
    )
    titles = [l["title"] for l in client.get(f"/api/tasks/{task['id']}/links").json()]
    assert titles == ["Task only"]


# --- dashboard period -------------------------------------------------------

def test_dashboard_defaults_to_the_last_seven_days(client, users):
    login(client, "m1@x.com")
    payload = client.get("/api/dashboard/personal").json()
    assert payload["period"] == "week"


def test_dashboard_can_scope_to_today(client, users):
    login(client, "m1@x.com")
    payload = client.get("/api/dashboard/personal?period=today").json()
    assert payload["period"] == "today"
    assert payload["period_label"] == "today"
    # a single day, in the app timezone
    start = date.fromisoformat(str(payload["range"]["from"])[:10])
    end = date.fromisoformat(str(payload["range"]["to"])[:10])
    assert start == end == (date.today())


def test_today_excludes_yesterdays_completions(client, users):
    login(client, "m1@x.com")
    t = client.post("/api/tasks", headers=CSRF, json={"title": "Done today"}).json()
    client.post(f"/api/tasks/{t['id']}/status", headers=CSRF, json={"status": "in_progress"})
    client.post(f"/api/tasks/{t['id']}/status", headers=CSRF, json={"status": "completed"})

    assert client.get("/api/dashboard/personal?period=today").json()["counts"]["completed_in_range"] == 1

    # nudge the completion back before the week opens but inside the month
    from app.db import SessionLocal
    from app.models import Task

    db = SessionLocal()
    try:
        task = db.get(Task, t["id"])
        task.completed_at = task.completed_at - timedelta(days=10)
        db.commit()
    finally:
        db.close()

    assert client.get("/api/dashboard/personal?period=today").json()["counts"]["completed_in_range"] == 0
    assert client.get("/api/dashboard/personal?period=week").json()["counts"]["completed_in_range"] == 0
    assert client.get("/api/dashboard/personal?period=month").json()["counts"]["completed_in_range"] == 1


def test_period_is_honoured_on_the_executive_dashboard(client, users):
    login(client, "ceo@x.com")
    payload = client.get("/api/dashboard/executive?period=today").json()
    assert payload["period"] == "today"
    assert payload["period_label"] == "today"


def test_period_is_honoured_on_the_lead_dashboard(client, users):
    login(client, "lead@x.com")
    assert client.get("/api/dashboard/lead?period=month").json()["period"] == "month"
