"""Assignment notifications: per-person, transient, and filtered by `since`."""

from __future__ import annotations

from tests.conftest import CSRF, login


def test_a_member_is_told_about_work_assigned_to_them(client, users):
    login(client, "lead@x.com")
    client.post(
        "/api/tasks",
        headers=CSRF,
        json={"title": "For Mia", "assignee_id": users["m1"]},
    )

    login(client, "m1@x.com")
    items = client.get("/api/notifications").json()["items"]
    assert [i["task_title"] for i in items] == ["For Mia"]
    assert items[0]["actor_name"] == "Lead"


def test_notifications_never_mention_another_persons_task(client, users):
    login(client, "lead@x.com")
    client.post("/api/tasks", headers=CSRF, json={"title": "For Mia", "assignee_id": users["m1"]})
    client.post("/api/tasks", headers=CSRF, json={"title": "For Sam", "assignee_id": users["m2"]})

    login(client, "m2@x.com")
    items = client.get("/api/notifications").json()["items"]
    assert [i["task_title"] for i in items] == ["For Sam"]


def test_reassigning_away_clears_the_previous_owner(client, users):
    login(client, "lead@x.com")
    task = client.post(
        "/api/tasks", headers=CSRF, json={"title": "Moving", "assignee_id": users["m1"]}
    ).json()

    login(client, "m1@x.com")
    assert len(client.get("/api/notifications").json()["items"]) == 1

    login(client, "lead@x.com")
    client.post(
        f"/api/tasks/{task['id']}/assign", headers=CSRF, json={"assignee_id": users["m2"]}
    )

    login(client, "m1@x.com")
    assert client.get("/api/notifications").json()["items"] == []


def test_self_created_work_is_not_a_notification(client, users):
    login(client, "m1@x.com")
    client.post("/api/tasks", headers=CSRF, json={"title": "My own"})
    assert client.get("/api/notifications").json()["items"] == []


def test_since_filters_to_really_new_arrivals(client, users):
    login(client, "lead@x.com")
    client.post("/api/tasks", headers=CSRF, json={"title": "First", "assignee_id": users["m1"]})

    login(client, "m1@x.com")
    mark = client.get("/api/notifications").json()["server_time"]

    login(client, "lead@x.com")
    client.post("/api/tasks", headers=CSRF, json={"title": "Second", "assignee_id": users["m1"]})

    login(client, "m1@x.com")
    result = client.get(f"/api/notifications?since={mark}").json()
    assert [i["task_title"] for i in result["items"]] == ["Second"]
    assert result["unread"] == 1


def test_a_reassignment_yields_one_notification_not_several(client, users):
    login(client, "lead@x.com")
    task = client.post(
        "/api/tasks", headers=CSRF, json={"title": "Churn", "assignee_id": users["m1"]}
    ).json()
    client.post(f"/api/tasks/{task['id']}/status", headers=CSRF, json={"status": "in_progress"})

    login(client, "m1@x.com")
    items = client.get("/api/notifications").json()["items"]
    assert len([i for i in items if i["task_id"] == task["id"]]) == 1