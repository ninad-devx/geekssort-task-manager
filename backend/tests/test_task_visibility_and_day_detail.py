"""A task you just raised must be where you can see it.

The report: a lead pressed "New Task" on their own My Tasks list, and the task
"got lost". Two independent causes, either of which alone is enough.

*The dialog never asked.* `my-tasks` rendered `CreateTaskDialog` without
`showAssignee` and without `defaultAssignee`, so it posted `assignee_id: null`.
A member has `can_assign_to_others` false, so the server quietly rewrites that
to themselves and they never notice. A lead does not, so the task was created
unassigned -- and then belongs to Team Tasks / Unassigned, not to the list it was
created from.

*The Today scope hid it.* Even assigned correctly, a brand-new To Do task with
no due date that nobody has touched falls outside "overdue, in flight, due
today, or finished today". So it vanished on refresh and read as deleted.

These tests pin both halves, because fixing only the dialog still leaves the
task invisible and fixing only the scope still creates it unassigned.
"""

from __future__ import annotations

from datetime import date, timedelta

from tests.conftest import CSRF, login


def _task(client, **kw):
    payload = {"title": "Work item"}
    payload.update(kw)
    return client.post("/api/tasks", headers=CSRF, json=payload).json()


# --- creating from your own list --------------------------------------------

def test_a_lead_creating_from_my_tasks_can_pick_themselves(client, users):
    """The payload the dialog sends must be honoured for the person too."""
    login(client, "lead@x.com")
    t = client.post(
        "/api/tasks",
        headers=CSRF,
        json={"title": "Mine to do", "assignee_id": users["lead"]},
    ).json()
    assert t["assignee_id"] == users["lead"], "the server must not rewrite a lead's choice"

    mine = client.get("/api/tasks?mine=1").json()["items"]
    assert [x["id"] for x in mine] == [t["id"]]


def test_a_lead_may_deliberately_leave_a_task_unassigned(client, users):
    """Choosing "Unassigned" has to mean unassigned, not "assigned to me".

    The dialog used to send the default whenever the picker was blank, so the
    screen and the request disagreed and only the network knew the truth.
    """
    login(client, "lead@x.com")
    t = client.post("/api/tasks", headers=CSRF, json={"title": "Anyone can take it"}).json()
    assert t["assignee_id"] is None

    still_visible = client.get("/api/tasks?mine=1").json()
    assert t["id"] in [x["id"] for x in still_visible["items"]], (
        "an unassigned task you raised belongs on your own list"
    )
    board = client.get("/api/tasks/board?scope=open").json()
    assert t["id"] in [x["id"] for x in board["unassigned"]]


def test_a_member_is_still_forced_onto_themselves(client, users):
    login(client, "m1@x.com")
    t = client.post(
        "/api/tasks", headers=CSRF, json={"title": "Oops", "assignee_id": users["m2"]}
    )
    assert t.status_code == 403


# --- and it must still be there afterwards ----------------------------------

def test_a_task_created_today_appears_on_todays_board(client, users):
    """The headline case: create it, refresh, it is gone."""
    login(client, "lead@x.com")
    t = _task(client, assignee_id=users["lead"])

    listed = client.get("/api/tasks?mine=1&scope=today").json()
    assert t["id"] in [x["id"] for x in listed["items"]]
    assert client.get("/api/dashboard/personal?period=today").json()["counts"]["total"] >= 1


def test_a_brand_new_task_sorts_below_the_real_work(client, users):
    """Visible is not enough. It must not jump above the overdue rows."""
    login(client, "lead@x.com")
    overdue = _task(
        client,
        title="Slipped",
        assignee_id=users["lead"],
        due_date=(date.today() - timedelta(days=1)).isoformat(),
    )
    fresh = _task(client, title="Just raised", assignee_id=users["lead"])

    ids = [x["id"] for x in client.get("/api/tasks?mine=1&scope=today").json()["items"]]
    assert ids.index(overdue["id"]) < ids.index(fresh["id"])


def test_yesterdays_new_task_is_not_todays_problem(client, users):
    """The same rule must not make every undated todo permanent.

    A task raised yesterday and never started is backlog, not today's work --
    otherwise the board refills itself overnight and the Today view stops
    meaning anything.
    """
    from app.db import SessionLocal
    from app.models import Task, utcnow

    login(client, "lead@x.com")
    t = _task(client, title="Raised yesterday", assignee_id=users["lead"])

    db = SessionLocal()
    try:
        row = db.get(Task, t["id"])
        row.created_at = utcnow() - timedelta(days=1)
        db.commit()
    finally:
        db.close()

    ids = [x["id"] for x in client.get("/api/tasks?mine=1&scope=today").json()["items"]]
    assert t["id"] not in ids
    # Still reachable -- never deleted, never hidden from the open list.
    assert t["id"] in [x["id"] for x in client.get("/api/tasks?mine=1&scope=open").json()["items"]]


# --- per-day activity on a profile -----------------------------------------

def _today() -> str:
    return date.today().isoformat()


def test_a_profile_day_detail_lists_where_the_hours_went(client, users):
    from app.db import SessionLocal
    from app.models import EntryType, Source, Task, WorkSession, utcnow

    login(client, "m1@x.com")
    first = _task(client, title="Morning work")
    second = _task(client, title="Afternoon work")
    done = _task(client, title="Wrapped up")
    client.post(f"/api/tasks/{done['id']}/status", headers=CSRF, json={"status": "in_progress"})
    client.post(f"/api/tasks/{done['id']}/status", headers=CSRF, json={"status": "completed"})

    now = utcnow()
    db = SessionLocal()
    try:
        for task_id, hours in ((first["id"], 1), (second["id"], 2)):
            db.add(
                WorkSession(
                    task_id=task_id,
                    user_id=users["m1"],
                    entry_type=EntryType.work_session.value,
                    source=Source.manual.value,
                    started_at=now - timedelta(hours=hours + 1),
                    ended_at=now - timedelta(hours=1),
                    duration_seconds=hours * 3600,
                    created_at=now,
                )
            )
        db.commit()
    finally:
        db.close()

    body = client.get(f"/api/users/{users['m1']}/profile?days=30&day={_today()}").json()
    detail = body["day_detail"]
    assert detail is not None
    assert detail["day"] == _today()
    assert detail["seconds"] == 3 * 3600
    assert {e["task_title"] for e in detail["entries"]} == {"Morning work", "Afternoon work"}
    assert [row["title"] for row in detail["completed"]] == ["Wrapped up"]


def test_a_day_detail_reports_an_empty_day_honestly(client, users):
    login(client, "m1@x.com")
    yesterday = (date.today() - timedelta(days=1)).isoformat()
    detail = client.get(f"/api/users/{users['m1']}/profile?days=30&day={yesterday}").json()
    assert detail["day_detail"]["entries"] == []
    assert detail["day_detail"]["completed"] == []
    assert detail["day_detail"]["seconds"] == 0


def test_a_day_detail_never_shows_somebody_elses_work(client, users):
    """A member cannot use the day drill-down as a window onto a colleague."""
    login(client, "m1@x.com")
    body = client.get(f"/api/users/{users['m1']}/profile?days=30&day={_today()}")
    assert body.status_code == 200
    assert body.json()["day_detail"]["entries"] == []

    assert client.get(f"/api/users/{users['m2']}/profile?day={_today()}").status_code == 404


def test_no_day_means_no_detail_payload(client, users):
    login(client, "m1@x.com")
    body = client.get(f"/api/users/{users['m1']}/profile?days=30").json()
    assert body["day_detail"] is None