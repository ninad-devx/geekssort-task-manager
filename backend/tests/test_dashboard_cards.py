"""A dashboard card must land on a list that agrees with the number it showed.

The CEO/lead cards report company-wide figures, so they must open the company
list — and they must carry the selected period, or "completed today" (a number)
sits above a list showing every completed task (or, worse, the executive's own
empty one).
"""

from __future__ import annotations

from datetime import timedelta

from tests.conftest import CSRF, login


def _complete(client, title, assignee_id, *, days_ago: int = 0) -> int:
    from app.db import SessionLocal
    from app.models import Task, utcnow

    login(client, "lead@x.com")
    t = client.post(
        "/api/tasks", headers=CSRF, json={"title": title, "assignee_id": assignee_id}
    ).json()
    client.post(f"/api/tasks/{t['id']}/status", headers=CSRF, json={"status": "in_progress"})
    client.post(f"/api/tasks/{t['id']}/status", headers=CSRF, json={"status": "completed"})
    if days_ago:
        db = SessionLocal()
        try:
            row = db.get(Task, t["id"])
            row.completed_at = utcnow() - timedelta(days=days_ago)
            db.commit()
        finally:
            db.close()
    return t["id"]


def test_the_completed_card_destination_matches_the_card_number(client, users):
    _complete(client, "Finished today", users["m1"], days_ago=0)
    _complete(client, "Finished long ago", users["m2"], days_ago=10)

    login(client, "ceo@x.com")
    dash = client.get("/api/dashboard/executive?period=today").json()
    shown = dash["counts"]["completed_in_range"]
    lo = str(dash["range"]["from"])[:10]
    hi = str(dash["range"]["to"])[:10]

    listed = client.get(
        f"/api/tasks?status=completed&completed_from={lo}&completed_to={hi}"
    ).json()
    assert listed["total"] == shown
    titles = [t["title"] for t in listed["items"]]
    assert "Finished today" in titles
    assert "Finished long ago" not in titles


def test_the_ceo_own_task_list_is_not_what_the_company_card_points_at(client, users):
    """Regression guard: this is why the card used to look empty."""
    _complete(client, "Finished today", users["m1"], days_ago=0)
    login(client, "ceo@x.com")
    mine = client.get("/api/tasks?mine=1&status=completed").json()
    assert mine["total"] == 0, "the CEO owns nothing, which is why the old link was blank"

    everyone = client.get("/api/tasks?status=completed").json()
    assert everyone["total"] >= 1


def test_the_by_person_board_honours_the_completion_window(client, users):
    _complete(client, "Finished today", users["m1"], days_ago=0)
    _complete(client, "Finished long ago", users["m2"], days_ago=10)
    login(client, "ceo@x.com")
    board = client.get(
        "/api/tasks/board?status=completed&completed_from=2000-01-01"
        "&completed_to=2000-01-02&include_completed=true"
    ).json()
    assert board["people"] == []

    today_only = client.get(
        "/api/tasks/board?status=completed&include_completed=true"
    ).json()
    titles = [t["title"] for p in today_only["people"] for t in p["tasks"]]
    assert "Finished today" in titles


def test_completed_window_filters_are_optional(client, users):
    _complete(client, "Finished today", users["m1"], days_ago=0)
    login(client, "ceo@x.com")
    # no window at all still returns the completed work
    listed = client.get("/api/tasks?status=completed").json()
    assert any(t["title"] == "Finished today" for t in listed["items"])
