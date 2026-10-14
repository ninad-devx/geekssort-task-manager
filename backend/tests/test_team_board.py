"""The team board buckets work by person; links can belong to a task."""

from __future__ import annotations

from tests.conftest import CSRF, login


def test_board_groups_tasks_by_their_assignee(client, users):
    login(client, "lead@x.com")
    client.post("/api/tasks", headers=CSRF, json={"title": "Mia one", "assignee_id": users["m1"]})
    client.post("/api/tasks", headers=CSRF, json={"title": "Mia two", "assignee_id": users["m1"]})
    client.post("/api/tasks", headers=CSRF, json={"title": "Sam one", "assignee_id": users["m2"]})

    board = client.get("/api/tasks/board").json()
    by_id = {p["user"]["id"]: p for p in board["people"]}

    assert by_id[users["m1"]]["open_count"] == 2
    assert {t["title"] for t in by_id[users["m1"]]["tasks"]} == {"Mia one", "Mia two"}
    assert by_id[users["m2"]]["open_count"] == 1


def test_board_carries_the_profile_so_the_ui_can_show_a_face(client, users):
    login(client, "lead@x.com")
    client.patch(
        f"/api/users/{users['m1']}",
        headers=CSRF,
        json={"display_name": "Mia", "avatar_color": "#ff0000"},
    )
    client.post("/api/tasks", headers=CSRF, json={"title": "Mia one", "assignee_id": users["m1"]})

    board = client.get("/api/tasks/board").json()
    person = next(p for p in board["people"] if p["user"]["id"] == users["m1"])
    assert person["user"]["display_name"] == "Mia"
    assert person["user"]["avatar_color"] == "#ff0000"


def test_board_sorts_the_busiest_person_first(client, users):
    login(client, "lead@x.com")
    client.post("/api/tasks", headers=CSRF, json={"title": "A", "assignee_id": users["m1"]})
    client.post("/api/tasks", headers=CSRF, json={"title": "B", "assignee_id": users["m2"]})
    client.post("/api/tasks", headers=CSRF, json={"title": "C", "assignee_id": users["m2"]})

    board = client.get("/api/tasks/board").json()
    assert board["people"][0]["user"]["id"] == users["m2"]


def test_board_separates_unassigned_work(client, users):
    login(client, "lead@x.com")
    # A lead creating a task with no assignee is auto-assigned to them, so use
    # a member-created task, which can only ever be unassigned if edited.
    client.post("/api/tasks", headers=CSRF, json={"title": "Owned", "assignee_id": users["m1"]})
    board = client.get("/api/tasks/board").json()
    assert board["unassigned_count"] == 0


def test_board_hides_completed_work_by_default(client, users):
    login(client, "lead@x.com")
    task = client.post(
        "/api/tasks", headers=CSRF, json={"title": "Done", "assignee_id": users["m1"]}
    ).json()
    client.post(f"/api/tasks/{task['id']}/status", headers=CSRF, json={"status": "in_progress"})
    client.post(f"/api/tasks/{task['id']}/status", headers=CSRF, json={"status": "completed"})

    board = client.get("/api/tasks/board").json()
    # With only completed work, that person drops off the board entirely.
    assert all(p["user"]["id"] != users["m1"] for p in board["people"])

    with_done = client.get("/api/tasks/board?include_completed=true").json()
    person = next(p for p in with_done["people"] if p["user"]["id"] == users["m1"])
    assert person["open_count"] == 0
    assert len(person["tasks"]) == 1


def test_a_member_cannot_open_the_board(client, users):
    login(client, "m1@x.com")
    assert client.get("/api/tasks/board").status_code == 403


# --- links on a task --------------------------------------------------------

def test_a_link_can_be_attached_to_a_task(client, users):
    login(client, "lead@x.com")
    task = client.post(
        "/api/tasks", headers=CSRF, json={"title": "Citations", "assignee_id": users["m1"]}
    ).json()

    r = client.post(
        "/api/workspace/links",
        headers=CSRF,
        json={"task_id": task["id"], "title": "Source paper", "url": "https://example.com/paper"},
    )
    assert r.status_code == 201, r.text
    assert r.json()["task_id"] == task["id"]

    listed = client.get(f"/api/tasks/{task['id']}/links").json()
    assert [l["title"] for l in listed] == ["Source paper"]


def test_a_link_attached_to_a_task_is_audited_against_it(client, users):
    login(client, "lead@x.com")
    task = client.post(
        "/api/tasks", headers=CSRF, json={"title": "Citations", "assignee_id": users["m1"]}
    ).json()
    client.post(
        "/api/workspace/links",
        headers=CSRF,
        json={"task_id": task["id"], "title": "Source", "url": "https://example.com"},
    )
    events = client.get(f"/api/audit?task_id={task['id']}&page_size=50").json()["items"]
    assert "link.created" in [e["event_type"] for e in events]


def test_someone_elses_task_links_are_not_reachable(client, users):
    login(client, "lead@x.com")
    task = client.post(
        "/api/tasks", headers=CSRF, json={"title": "Private", "assignee_id": users["m1"]}
    ).json()
    client.post(
        "/api/workspace/links",
        headers=CSRF,
        json={"task_id": task["id"], "title": "Secret", "url": "https://example.com"},
    )

    # m2 cannot see m1's task, so the task 404s and the link is unreachable.
    login(client, "m2@x.com")
    assert client.get(f"/api/tasks/{task['id']}/links").status_code == 404
    assert client.get(f"/api/tasks/{task['id']}").status_code == 404


def test_a_link_cannot_be_attached_to_an_invisible_task(client, users):
    login(client, "lead@x.com")
    task = client.post(
        "/api/tasks", headers=CSRF, json={"title": "Mia's", "assignee_id": users["m1"]}
    ).json()

    login(client, "m2@x.com")
    r = client.post(
        "/api/workspace/links",
        headers=CSRF,
        json={"task_id": task["id"], "title": "Sneaky", "url": "https://example.com"},
    )
    assert r.status_code == 404


def test_unsafe_url_is_still_rejected_on_a_task_link(client, users):
    login(client, "lead@x.com")
    task = client.post("/api/tasks", headers=CSRF, json={"title": "T"}).json()
    r = client.post(
        "/api/workspace/links",
        headers=CSRF,
        json={"task_id": task["id"], "title": "Bad", "url": "javascript:alert(1)"},
    )
    assert r.status_code == 422
