"""Reminders, categories, and the reshaped dashboard."""

from __future__ import annotations

from tests.conftest import CSRF, login


# --- reminders --------------------------------------------------------------

def test_a_lead_can_remind_the_assignee(client, users):
    login(client, "lead@x.com")
    task = client.post(
        "/api/tasks", headers=CSRF, json={"title": "Ship it", "assignee_id": users["m1"]}
    ).json()
    r = client.post(
        f"/api/tasks/{task['id']}/remind", headers=CSRF, json={"message": "Needed today"}
    )
    assert r.status_code == 200, r.text
    assert r.json()["assignee"]["id"] == users["m1"]
    assert r.json()["message"] == "Needed today"


def test_a_reminder_reaches_the_assignee_notification_feed(client, users):
    login(client, "lead@x.com")
    task = client.post(
        "/api/tasks", headers=CSRF, json={"title": "Ship it", "assignee_id": users["m1"]}
    ).json()
    mark = None

    login(client, "m1@x.com")
    mark = client.get("/api/notifications").json()["server_time"]

    login(client, "lead@x.com")
    client.post(f"/api/tasks/{task['id']}/remind", headers=CSRF, json={"message": "Now please"})

    login(client, "m1@x.com")
    items = client.get(f"/api/notifications?since={mark}").json()["items"]
    assert len(items) == 1
    assert items[0]["is_reminder"] is True
    assert items[0]["message"] == "Now please"
    assert items[0]["actor_name"] == "Lead"


def test_a_member_cannot_send_a_reminder(client, users):
    login(client, "lead@x.com")
    task = client.post(
        "/api/tasks", headers=CSRF, json={"title": "Ship it", "assignee_id": users["m1"]}
    ).json()
    login(client, "m2@x.com")
    r = client.post(f"/api/tasks/{task['id']}/remind", headers=CSRF, json={})
    assert r.status_code in (403, 404)


def test_a_reminder_is_audited(client, users):
    login(client, "lead@x.com")
    task = client.post(
        "/api/tasks", headers=CSRF, json={"title": "Ship it", "assignee_id": users["m1"]}
    ).json()
    client.post(f"/api/tasks/{task['id']}/remind", headers=CSRF, json={})
    events = client.get(f"/api/audit?task_id={task['id']}&page_size=50").json()["items"]
    assert "task.reminder_sent" in [e["event_type"] for e in events]


# --- categories -------------------------------------------------------------

def test_categories_seed_on_first_read(client, users):
    login(client, "lead@x.com")
    rows = client.get("/api/categories").json()
    slugs = {r["slug"] for r in rows}
    assert {"content", "campaign", "other"} <= slugs
    assert all(r["is_active"] for r in rows)


def test_a_member_cannot_manage_categories(client, users):
    login(client, "m1@x.com")
    assert client.get("/api/categories").status_code == 403


def test_admin_can_add_rename_and_retire_a_category(client, users):
    login(client, "lead@x.com")
    created = client.post("/api/categories", headers=CSRF, json={"label": "Paid Social"}).json()
    assert created["slug"] == "paid_social"
    assert created["label"] == "Paid Social"

    renamed = client.patch(
        f"/api/categories/{created['slug']}", headers=CSRF, json={"label": "Paid and Boosted"}
    ).json()
    assert renamed["label"] == "Paid and Boosted"
    assert renamed["slug"] == "paid_social", "the slug must not move, tasks reference it"

    retired = client.delete(f"/api/categories/{created['slug']}", headers=CSRF).json()
    assert retired["is_active"] is False

    restored = client.patch(
        f"/api/categories/{created['slug']}", headers=CSRF, json={"is_active": True}
    ).json()
    assert restored["is_active"] is True


def test_duplicate_category_names_are_refused(client, users):
    login(client, "lead@x.com")
    client.post("/api/categories", headers=CSRF, json={"label": "Widget Work"})
    again = client.post("/api/categories", headers=CSRF, json={"label": "Widget work"})
    assert again.status_code == 409


def test_category_counts_reflect_real_tasks(client, users):
    login(client, "lead@x.com")
    client.post(
        "/api/tasks", headers=CSRF, json={"title": "With cat", "category": "content"}
    )
    rows = client.get("/api/categories").json()
    content = next(r for r in rows if r["slug"] == "content")
    assert content["task_count"] == 1


def test_category_changes_appear_in_the_activity_feed(client, users):
    login(client, "lead@x.com")
    created = client.post("/api/categories", headers=CSRF, json={"label": "Feed Check"}).json()
    client.patch(
        f"/api/categories/{created['slug']}", headers=CSRF, json={"label": "Feed Check 2"}
    )

    events = client.get("/api/audit?page_size=100").json()["items"]
    kinds = [e["event_type"] for e in events]
    assert "category.created" in kinds
    assert "category.updated" in kinds

    # and the feed still serves, which is the regression that bit us
    assert client.get("/api/audit?page=1&page_size=50").status_code == 200


def test_audited_entities_always_carry_an_integer_id(client, users):
    """`audit_events.entity_id` is an INTEGER column; a slug in it once 500'd
    the whole activity page."""
    login(client, "lead@x.com")
    client.post("/api/tasks", headers=CSRF, json={"title": "T"})
    client.post("/api/categories", headers=CSRF, json={"label": "Integral"})

    for event in client.get("/api/audit?page_size=100").json()["items"]:
        assert event["entity_id"] is None or isinstance(event["entity_id"], int), event


def test_a_stray_non_integer_audit_row_cannot_blank_the_feed(client, users):
    login(client, "lead@x.com")
    client.post("/api/tasks", headers=CSRF, json={"title": "T"})

    # write straight past the ORM, the way the original bug did
    import pytest
    from sqlalchemy import text
    from sqlalchemy.exc import DBAPIError

    from app.db import IS_POSTGRES, SessionLocal

    bad_insert = text(
        "INSERT INTO audit_events (event_type, request_id, actor_name, entity_type, "
        "entity_id, summary, created_at) VALUES ('task.created', 'x', 'system', "
        "'category', 'a_slug_not_a_number', 'bad row', '2026-01-01 00:00:00')"
    )
    db = SessionLocal()
    try:
        if IS_POSTGRES:
            # Postgres refuses the row outright: entity_id is INTEGER and the
            # text will not cast. That is the stronger of the two outcomes --
            # the corrupt row cannot exist at all -- so assert the refusal and
            # then that the feed is unharmed.
            with pytest.raises(DBAPIError):
                db.execute(bad_insert)
            db.rollback()
        else:
            db.execute(text("DROP TRIGGER IF EXISTS audit_events_no_update"))
            db.execute(bad_insert)
            db.commit()
    finally:
        db.close()

    page = client.get("/api/audit?page=1&page_size=50")
    assert page.status_code == 200, "one bad row must not take down the feed"
    assert page.json()["total"] >= 1


# --- dashboard shape --------------------------------------------------------

def test_dashboard_cards_report_in_progress_and_completed(client, users):
    login(client, "m1@x.com")
    a = client.post("/api/tasks", headers=CSRF, json={"title": "Working"}).json()
    client.post(f"/api/tasks/{a['id']}/status", headers=CSRF, json={"status": "in_progress"})
    b = client.post("/api/tasks", headers=CSRF, json={"title": "Finished"}).json()
    client.post(f"/api/tasks/{b['id']}/status", headers=CSRF, json={"status": "in_progress"})
    client.post(f"/api/tasks/{b['id']}/status", headers=CSRF, json={"status": "completed"})

    counts = client.get("/api/dashboard/personal").json()["counts"]
    assert counts["in_progress"] == 1
    assert counts["completed_in_range"] == 1


def test_dashboard_worklists_split_into_four_sections(client, users):
    login(client, "m1@x.com")
    t = client.post(
        "/api/tasks", headers=CSRF, json={"title": "Late", "due_date": "2020-01-01"}
    ).json()
    lists = client.get("/api/dashboard/personal").json()["worklists"]
    assert set(lists) == {"in_progress", "completed", "overdue", "blocked"}
    assert any(row["id"] == t["id"] for row in lists["overdue"])
    assert lists["overdue"][0]["is_overdue"] is True
    assert lists["overdue"][0]["assignee"]["id"] == users["m1"]


def test_blocked_section_names_the_reason_holder(client, users):
    login(client, "m1@x.com")
    t = client.post("/api/tasks", headers=CSRF, json={"title": "Stuck"}).json()
    client.post(f"/api/tasks/{t['id']}/status", headers=CSRF, json={"status": "in_progress"})
    client.post(
        f"/api/tasks/{t['id']}/status",
        headers=CSRF,
        json={"status": "blocked", "reason": "waiting on legal"},
    )
    lists = client.get("/api/dashboard/personal").json()["worklists"]
    assert [row["title"] for row in lists["blocked"]] == ["Stuck"]


def test_worklists_never_leak_another_persons_task(client, users):
    login(client, "lead@x.com")
    client.post("/api/tasks", headers=CSRF, json={"title": "Mia's", "assignee_id": users["m1"]})
    login(client, "m2@x.com")
    lists = client.get("/api/dashboard/personal").json()["worklists"]
    for section in lists.values():
        assert all(row["title"] != "Mia's" for row in section)
