"""Regression tests, one per bug that was found by probing the running app.

Every test here failed against the code as it was before the fixes. They are
written as behaviour ("discarding a timer must not brick the task") rather than
as implementation checks, so they keep working if the internals move again.
"""

from __future__ import annotations

from datetime import date, timedelta

import pytest
from sqlalchemy import select, text

from app.aggregate import tracked_seconds
from app.db import SessionLocal, engine
from app.models import LoginAttempt, Role, Task, WorkSession, utcnow
from app.serializers import TaskContext
from tests.conftest import CSRF, login, make_user


def _running(task_id: int, include_deleted: bool = False) -> list[WorkSession]:
    db = SessionLocal()
    try:
        stmt = select(WorkSession).where(
            WorkSession.task_id == task_id, WorkSession.ended_at.is_(None)
        )
        if not include_deleted:
            stmt = stmt.where(WorkSession.deleted_at.is_(None))
        return db.scalars(stmt).all()
    finally:
        db.close()


def _idx(client) -> None:
    db = SessionLocal()
    try:
        yield
    finally:
        db.close()


# --- the 500 that bricked a task --------------------------------------------


def test_discarding_a_running_timer_leaves_the_task_trackable(client, users):
    """Discarding a running entry used to leave `ended_at` NULL, which held the
    partial unique index slot. The next start on that task raised IntegrityError
    -> HTTP 500, permanently."""
    login(client, "lead@x.com")
    task = client.post(
        "/api/tasks", headers=CSRF, json={"title": "Shared", "assignee_id": users["m1"]}
    ).json()
    login(client, "m1@x.com")
    log_id = client.post(f"/api/tasks/{task['id']}/timer/start", headers=CSRF).json()["log"]["id"]

    assert client.delete(f"/api/logs/{log_id}", headers=CSRF).status_code == 200

    again = client.post(f"/api/tasks/{task['id']}/timer/start", headers=CSRF)
    assert again.status_code == 200, again.text

    view = client.get(f"/api/tasks/{task['id']}").json()
    assert "pause_timer" in view["allowed_actions"]
    assert view["running"] is not None


def test_discarding_a_running_timer_records_the_elapsed_time(client, users):
    login(client, "lead@x.com")
    task = client.post(
        "/api/tasks", headers=CSRF, json={"title": "T", "assignee_id": users["m1"]}
    ).json()
    login(client, "m1@x.com")
    log_id = client.post(f"/api/tasks/{task['id']}/timer/start", headers=CSRF).json()["log"]["id"]
    client.delete(f"/api/logs/{log_id}", headers=CSRF)

    db = SessionLocal()
    try:
        log = db.get(WorkSession, log_id)
        assert log.ended_at is not None
        assert log.deleted_at is not None
        assert log.duration_seconds is not None
    finally:
        db.close()


def test_a_partial_running_index_row_left_by_an_older_build_is_repaired(client, users):
    """The on-boot repair must close rows an older build left behind, otherwise
    the corrected index cannot be created at all."""
    login(client, "lead@x.com")
    task = client.post(
        "/api/tasks", headers=CSRF, json={"title": "T", "assignee_id": users["m1"]}
    ).json()
    login(client, "m1@x.com")
    log_id = client.post(f"/api/tasks/{task['id']}/timer/start", headers=CSRF).json()["log"]["id"]

    # Recreate the broken shape directly: soft-deleted, still open.
    db = SessionLocal()
    try:
        log = db.get(WorkSession, log_id)
        log.deleted_at = utcnow()
        db.commit()
    finally:
        db.close()

    from app.db import apply_schema_repairs

    conn = engine.raw_connection()
    try:
        apply_schema_repairs(conn)
    finally:
        conn.close()

    login(client, "m1@x.com")
    assert client.post(f"/api/tasks/{task['id']}/timer/start", headers=CSRF).status_code == 200


def test_a_lead_can_create_a_genuinely_unassigned_task(client, users):
    """`assignee_id: None` was rewritten to the caller's own id, so the create
    dialog's "Unassigned" option produced a task assigned to whoever created it
    and the board's unassigned bucket was unreachable."""
    login(client, "lead@x.com")
    task = client.post("/api/tasks", headers=CSRF, json={"title": "Backlog item"}).json()
    assert task["assignee_id"] is None
    assert task["assignee"] is None

    board = client.get("/api/tasks/board").json()
    assert board["unassigned_count"] == 1
    assert [t["title"] for t in board["unassigned"]] == ["Backlog item"]


def test_a_member_still_cannot_leave_a_task_unassigned(client, users):
    login(client, "m1@x.com")
    task = client.post("/api/tasks", headers=CSRF, json={"title": "Mine"}).json()
    assert task["assignee_id"] == users["m1"]


def test_the_audited_summary_says_nobody_for_an_unassigned_task(client, users):
    login(client, "lead@x.com")
    client.post("/api/tasks", headers=CSRF, json={"title": "Backlog item"})
    feed = client.get("/api/audit?limit=5").json()
    entry = next(e for e in feed["items"] if e["event_type"] == "task.created")
    assert "nobody" in entry["summary"]


def test_the_declared_indexes_actually_exist(client, users):
    """`uq_folder_sibling_name` was declared as a module-level Index built from
    strings, so it had no owning Table and `create_all` never emitted it."""
    db = SessionLocal()
    try:
        names = {
            r[0]
            for r in db.execute(
                text("select name from sqlite_master where type='index'")
            ).all()
        }
    finally:
        db.close()
    assert "uq_folder_sibling_name" in names
    assert "uq_running_session_per_user_task" in names


# --- ownership of a running timer -------------------------------------------


def test_task_running_block_is_the_callers_own_timer(client, users):
    """`running` used to be any user's timer on the task, and carried no
    `user_id`, so a viewer could be offered a Pause button for somebody else's
    clock -- the id went straight into POST /timer/pause."""
    login(client, "lead@x.com")
    task = client.post(
        "/api/tasks", headers=CSRF, json={"title": "T", "assignee_id": users["m1"]}
    ).json()
    login(client, "m1@x.com")
    client.post(f"/api/tasks/{task['id']}/timer/start", headers=CSRF)

    login(client, "lead@x.com")
    view = client.get(f"/api/tasks/{task['id']}").json()
    assert view["running"] is None
    assert [r["user_id"] for r in view["other_runners"]] == [users["m1"]]
    assert view["other_runners"][0]["user"]["full_name"] == "Member One"
    assert view["other_runners"][0]["is_mine"] is False
    # A lead has no timer of their own, so nothing pauseable must be offered.
    assert "pause_timer" not in view["allowed_actions"]
    assert client.get("/api/timer/current").json()["running"] == []


def test_the_assignee_still_sees_their_own_running_timer(client, users):
    login(client, "lead@x.com")
    task = client.post(
        "/api/tasks", headers=CSRF, json={"title": "T", "assignee_id": users["m1"]}
    ).json()
    login(client, "m1@x.com")
    client.post(f"/api/tasks/{task['id']}/timer/start", headers=CSRF)

    view = client.get(f"/api/tasks/{task['id']}").json()
    assert view["running"]["is_mine"] is True
    assert view["running"]["user_id"] == users["m1"]
    assert view["other_runners"] == []
    assert "pause_timer" in view["allowed_actions"]
    assert "start_timer" not in view["allowed_actions"]

    timer = client.get("/api/timer/current").json()["running"][0]
    assert timer["is_mine"] is True
    assert timer["user_id"] == users["m1"]


# --- time in progress --------------------------------------------------------


def test_time_accruing_on_an_open_timer_is_reported(client, users):
    """Every roll-up filtered on `ended_at IS NOT NULL`, so someone six hours
    into a timer was reported as having tracked zero."""
    login(client, "lead@x.com")
    task = client.post(
        "/api/tasks", headers=CSRF, json={"title": "T", "assignee_id": users["m1"]}
    ).json()
    login(client, "m1@x.com")

    # Backdate the start so the accrual is unambiguously non-zero.
    db = SessionLocal()
    try:
        started = client.post(f"/api/tasks/{task['id']}/timer/start", headers=CSRF)
        log_id = started.json()["log"]["id"]
        log = db.get(WorkSession, log_id)
        log.started_at = utcnow() - timedelta(hours=3)
        db.commit()
    finally:
        db.close()

    view = client.get(f"/api/tasks/{task['id']}").json()
    assert 10_000 < view["tracked_seconds"] < 11_000

    summary = client.get("/api/time/summary?days=30").json()
    assert summary["total_seconds"] > 10_000

    personal = client.get("/api/dashboard/personal?days=30").json()
    assert personal["counts"]["tracked_seconds"] > 10_000
    assert personal["daily"] and personal["daily"][0]["seconds"] > 10_000

    assert client.get("/api/dashboard/time-summary?days=30").json()["total_seconds"] > 10_000


def test_tracked_seconds_adds_closed_and_running(client, users):
    login(client, "lead@x.com")
    task = client.post(
        "/api/tasks", headers=CSRF, json={"title": "T", "assignee_id": users["m1"]}
    ).json()
    login(client, "m1@x.com")
    start = utcnow() - timedelta(hours=4)
    client.post(
        f"/api/tasks/{task['id']}/logs",
        headers=CSRF,
        json={
            "entry_type": "work_session",
            "started_at": start.isoformat(),
            "ended_at": (start + timedelta(hours=1)).isoformat(),
        },
    )
    client.post(f"/api/tasks/{task['id']}/timer/start", headers=CSRF)
    db = SessionLocal()
    try:
        log = db.scalars(
            select(WorkSession).where(WorkSession.ended_at.is_(None))
        ).one()
        log.started_at = utcnow() - timedelta(hours=2)
        db.commit()
        total = tracked_seconds(db, task["id"])
    finally:
        db.close()
    # One closed hour plus roughly two hours still running.
    assert 3 * 3600 - 120 < total < 3 * 3600 + 120


# --- the dashboard that said every timer was brand new -----------------------


def test_personal_dashboard_reports_real_elapsed_for_a_running_timer(client, users):
    """`elapsed_seconds` was hardcoded to 0 and `is_stale` to False. The real
    values lived in a block after a `return` and never executed."""
    login(client, "lead@x.com")
    task = client.post(
        "/api/tasks", headers=CSRF, json={"title": "T", "assignee_id": users["m1"]}
    ).json()
    login(client, "m1@x.com")
    log_id = client.post(f"/api/tasks/{task['id']}/timer/start", headers=CSRF).json()["log"]["id"]

    db = SessionLocal()
    try:
        log = db.get(WorkSession, log_id)
        log.started_at = utcnow() - timedelta(hours=5)
        db.commit()
    finally:
        db.close()

    running = client.get("/api/dashboard/personal").json()["running"]
    assert running["elapsed_seconds"] > 5 * 3600 - 60
    assert running["is_stale"] is False


def test_personal_dashboard_flags_a_stale_timer(client, users):
    from app.config import settings

    login(client, "lead@x.com")
    task = client.post(
        "/api/tasks", headers=CSRF, json={"title": "T", "assignee_id": users["m1"]}
    ).json()
    login(client, "m1@x.com")
    log_id = client.post(f"/api/tasks/{task['id']}/timer/start", headers=CSRF).json()["log"]["id"]

    db = SessionLocal()
    try:
        log = db.get(WorkSession, log_id)
        log.started_at = utcnow() - timedelta(hours=settings.MAX_TIMER_HOURS + 1)
        db.commit()
    finally:
        db.close()

    assert client.get("/api/dashboard/personal").json()["running"]["is_stale"] is True


# --- manual entries that quietly lost hours ---------------------------------


def test_a_manual_entry_ending_in_the_future_is_refused_not_shortened(client, users):
    """`ended_at = min(ended_at, now)` ran before validation, so END_IN_FUTURE
    could never fire and a 7-hour request was stored as 2 hours with no warning."""
    login(client, "lead@x.com")
    task = client.post(
        "/api/tasks", headers=CSRF, json={"title": "T", "assignee_id": users["m1"]}
    ).json()
    login(client, "m1@x.com")
    now = utcnow()
    r = client.post(
        f"/api/tasks/{task['id']}/logs",
        headers=CSRF,
        json={
            "entry_type": "work_session",
            "started_at": (now - timedelta(hours=2)).isoformat(),
            "ended_at": (now + timedelta(hours=5)).isoformat(),
        },
    )
    assert r.status_code == 422
    assert r.json()["detail"]["code"] == "END_IN_FUTURE"


def test_a_manual_entry_within_skew_is_still_accepted(client, users):
    login(client, "lead@x.com")
    task = client.post(
        "/api/tasks", headers=CSRF, json={"title": "T", "assignee_id": users["m1"]}
    ).json()
    login(client, "m1@x.com")
    now = utcnow()
    r = client.post(
        f"/api/tasks/{task['id']}/logs",
        headers=CSRF,
        json={
            "entry_type": "work_session",
            "started_at": (now - timedelta(hours=2)).isoformat(),
            "ended_at": (now + timedelta(minutes=1)).isoformat(),
        },
    )
    assert r.status_code == 201
    # 2 hours plus the one minute of skew that is tolerated on purpose
    assert r.json()["duration_seconds"] == 2 * 3600 + 60


def test_a_manual_entry_starting_in_the_future_names_the_real_problem(client, users):
    login(client, "lead@x.com")
    task = client.post(
        "/api/tasks", headers=CSRF, json={"title": "T", "assignee_id": users["m1"]}
    ).json()
    login(client, "m1@x.com")
    base = utcnow()
    r = client.post(
        f"/api/tasks/{task['id']}/logs",
        headers=CSRF,
        json={
            "entry_type": "work_session",
            "started_at": (base + timedelta(days=1)).isoformat(),
            "ended_at": (base + timedelta(days=1, hours=1)).isoformat(),
        },
    )
    assert r.status_code == 422
    assert r.json()["detail"]["code"] == "START_IN_FUTURE"


# --- filters that lied --------------------------------------------------------


def test_priority_sorts_by_urgency_not_alphabetically(client, users):
    """`priority` is a string, so ORDER BY ranked high < low < medium < urgent."""
    login(client, "lead@x.com")
    for p in ("urgent", "low", "medium", "high"):
        client.post("/api/tasks", headers=CSRF, json={"title": p.upper(), "priority": p})
    titles = [
        t["title"] for t in client.get("/api/tasks?sort=priority&order=asc").json()["items"]
    ]
    assert titles == ["LOW", "MEDIUM", "HIGH", "URGENT"]
    titles = [
        t["title"] for t in client.get("/api/tasks?sort=priority&order=desc").json()["items"]
    ]
    assert titles == ["URGENT", "HIGH", "MEDIUM", "LOW"]


@pytest.mark.parametrize(
    "query",
    [
        "sort=created;DROP TABLE tasks",
        "order=sideways",
        "status=banana",
        "priority=very",
    ],
)
def test_an_unknown_filter_value_is_rejected(client, users, query):
    """A typo used to answer 200 with zero rows, indistinguishable from a real
    filter that matched nothing."""
    login(client, "lead@x.com")
    assert client.get(f"/api/tasks?{query}").status_code == 422


def test_deleted_tasks_can_be_asked_for_on_their_own(client, users):
    login(client, "lead@x.com")
    client.post("/api/tasks", headers=CSRF, json={"title": "keep"})
    gone = client.post("/api/tasks", headers=CSRF, json={"title": "gone"}).json()
    client.delete(f"/api/tasks/{gone['id']}", headers=CSRF)

    everything = client.get("/api/tasks?include_deleted=true").json()
    assert sorted(t["title"] for t in everything["items"]) == ["gone", "keep"]

    only_deleted = client.get("/api/tasks?deleted_only=true").json()
    assert [t["title"] for t in only_deleted["items"]] == ["gone"]


def test_a_member_still_cannot_ask_for_deleted_tasks(client, users):
    login(client, "m1@x.com")
    assert client.get("/api/tasks?deleted_only=true").status_code == 403
    assert client.get("/api/tasks?include_deleted=true").status_code == 403


def test_task_search_treats_like_wildcards_literally(client, users):
    """Workspace search escaped `%`; the task list did not, so typing `%`
    matched every task in the company."""
    login(client, "lead@x.com")
    client.post("/api/tasks", headers=CSRF, json={"title": "50% off promo"})
    client.post("/api/tasks", headers=CSRF, json={"title": "Q3 launch"})

    # A literal "%" matches only the title that really contains one.
    literal = client.get("/api/tasks?q=%25").json()
    assert literal["total"] == 1
    assert literal["items"][0]["title"] == "50% off promo"
    assert client.get("/api/tasks?q=50%25").json()["total"] == 1
    assert client.get("/api/tasks?q=Q3").json()["total"] == 1


def test_the_board_honours_every_filter_the_flat_list_does(client, users):
    """priority, assignee, category and overdue were accepted by the board and
    silently ignored, leaving the picker looking functional."""
    login(client, "lead@x.com")
    client.post(
        "/api/tasks",
        headers=CSRF,
        json={"title": "Urgent one", "priority": "urgent", "assignee_id": users["m1"]},
    )
    client.post(
        "/api/tasks",
        headers=CSRF,
        json={"title": "Low one", "priority": "low", "assignee_id": users["m2"]},
    )

    urgent = client.get("/api/tasks/board?priority=urgent").json()
    titles = [t["title"] for p in urgent["people"] for t in p["tasks"]]
    assert titles == ["Urgent one"]

    only_m2 = client.get(f"/api/tasks/board?assignee_id={users['m2']}").json()
    assert [t["title"] for p in only_m2["people"] for t in p["tasks"]] == ["Low one"]

    assert client.get("/api/tasks/board?status=banana").status_code == 422


# --- links --------------------------------------------------------------------


def test_a_link_can_be_detached_from_its_folder(client, users):
    """`if payload.folder_id is not None` meant an explicit null was ignored."""
    login(client, "lead@x.com")
    folder = client.post("/api/workspace/folders", headers=CSRF, json={"name": "F1"}).json()
    link = client.post(
        "/api/workspace/links",
        headers=CSRF,
        json={"title": "L", "url": "https://example.com", "folder_id": folder["id"]},
    ).json()
    assert link["folder_id"] == folder["id"]

    detached = client.patch(
        f"/api/workspace/links/{link['id']}", headers=CSRF, json={"folder_id": None}
    )
    assert detached.status_code == 200
    assert detached.json()["folder_id"] is None
    assert detached.json()["folder_name"] is None


def test_omitting_folder_id_leaves_the_link_where_it_is(client, users):
    login(client, "lead@x.com")
    folder = client.post("/api/workspace/folders", headers=CSRF, json={"name": "F1"}).json()
    link = client.post(
        "/api/workspace/links",
        headers=CSRF,
        json={"title": "L", "url": "https://example.com", "folder_id": folder["id"]},
    ).json()
    renamed = client.patch(f"/api/workspace/links/{link['id']}", headers=CSRF, json={"title": "L2"})
    assert renamed.json()["folder_id"] == folder["id"]


def test_a_note_can_be_cleared(client, users):
    """A field could be typed but never removed, because `is not None` could not
    distinguish 'left alone' from 'explicitly blank'."""
    login(client, "lead@x.com")
    task = client.post(
        "/api/tasks", headers=CSRF, json={"title": "T", "assignee_id": users["m1"]}
    ).json()
    login(client, "m1@x.com")
    now = utcnow()
    note = client.post(
        f"/api/tasks/{task['id']}/logs",
        headers=CSRF,
        json={"entry_type": "note", "started_at": now.isoformat(), "note": "first"},
    ).json()
    assert note["note"] == "first"

    cleared = client.patch(
        f"/api/logs/{note['id']}", headers=CSRF, json={"note": None}
    )
    assert cleared.status_code == 200
    assert cleared.json()["note"] is None


def test_editing_a_note_does_not_wipe_the_fields_it_never_mentioned(client, users):
    """The note branch rebuilt the payload with a full `model_dump()`, marking
    every field as present so anything omitted was blanked."""
    login(client, "lead@x.com")
    task = client.post(
        "/api/tasks", headers=CSRF, json={"title": "T", "assignee_id": users["m1"]}
    ).json()
    login(client, "m1@x.com")
    now = utcnow()
    note = client.post(
        f"/api/tasks/{task['id']}/logs",
        headers=CSRF,
        json={
            "entry_type": "note",
            "started_at": now.isoformat(),
            "note": "first",
            "progress_percent": 40,
        },
    ).json()
    edited = client.patch(
        f"/api/logs/{note['id']}", headers=CSRF, json={"note": "second"}
    ).json()
    assert edited["note"] == "second"
    assert edited["progress_percent"] == 40


def test_sending_a_changed_end_time_without_opting_in_is_reported(client, users):
    """The client asserted it was not changing `ended_at` and then sent a
    different one. Swallowing that loses the edit silently."""
    login(client, "lead@x.com")
    task = client.post(
        "/api/tasks", headers=CSRF, json={"title": "T", "assignee_id": users["m1"]}
    ).json()
    login(client, "m1@x.com")
    start = utcnow() - timedelta(hours=3)
    log = client.post(
        f"/api/tasks/{task['id']}/logs",
        headers=CSRF,
        json={
            "entry_type": "work_session",
            "started_at": start.isoformat(),
            "ended_at": (start + timedelta(hours=1)).isoformat(),
        },
    ).json()

    r = client.patch(
        f"/api/logs/{log['id']}",
        headers=CSRF,
        json={
            "ended_at": (start + timedelta(hours=2)).isoformat(),
            "if_ended_at_unchanged": True,
        },
    )
    assert r.status_code == 409
    assert r.json()["detail"]["code"] == "ENDED_AT_CONFLICT"


def test_opting_in_lets_the_end_time_change(client, users):
    login(client, "lead@x.com")
    task = client.post(
        "/api/tasks", headers=CSRF, json={"title": "T", "assignee_id": users["m1"]}
    ).json()
    login(client, "m1@x.com")
    start = utcnow() - timedelta(hours=3)
    log = client.post(
        f"/api/tasks/{task['id']}/logs",
        headers=CSRF,
        json={
            "entry_type": "work_session",
            "started_at": start.isoformat(),
            "ended_at": (start + timedelta(hours=1)).isoformat(),
        },
    ).json()

    r = client.patch(
        f"/api/logs/{log['id']}",
        headers=CSRF,
        json={
            "ended_at": (start + timedelta(hours=2)).isoformat(),
            "if_ended_at_unchanged": False,
        },
    )
    assert r.status_code == 200
    assert r.json()["duration_seconds"] == 2 * 3600


# --- notifications -------------------------------------------------------------


def test_the_badge_count_and_the_new_flag_agree(client, users):
    """`is_new` was hardcoded True while `unread` was 0 when no watermark was
    sent, so the two halves of the same answer contradicted each other."""
    login(client, "lead@x.com")
    client.post("/api/tasks", headers=CSRF, json={"title": "N", "assignee_id": users["m1"]})
    login(client, "m1@x.com")

    without = client.get("/api/notifications").json()
    assert without["items"]
    assert without["unread"] == len(without["items"])
    assert all(i["is_new"] for i in without["items"])

    with_mark = client.get("/api/notifications?since=2000-01-01T00:00:00").json()
    assert with_mark["unread"] == len(with_mark["items"]) == len(without["items"])


def test_a_watermark_hides_what_was_already_displayed(client, users):
    login(client, "lead@x.com")
    client.post("/api/tasks", headers=CSRF, json={"title": "N", "assignee_id": users["m1"]})
    login(client, "m1@x.com")
    seen = client.get("/api/notifications").json()["server_time"]
    assert client.get(f"/api/notifications?since={seen}").json()["items"] == []


# --- timers left running by a departure ----------------------------------------


def test_deactivating_someone_closes_every_timer_they_had_running(client, users):
    """Only the most recent timer was closed; the rest kept ticking against a
    deactivated account."""
    login(client, "lead@x.com")
    tasks = [
        client.post(
            "/api/tasks", headers=CSRF, json={"title": f"T{i}", "assignee_id": users["m1"]}
        ).json()
        for i in range(3)
    ]
    login(client, "m1@x.com")
    for t in tasks:
        client.post(f"/api/tasks/{t['id']}/timer/start", headers=CSRF)
    assert len(client.get("/api/timer/current").json()["running"]) == 3

    login(client, "lead@x.com")
    for t in tasks:
        client.post(f"/api/tasks/{t['id']}/status", headers=CSRF, json={"status": "todo"})

    # Hand every task on so the deactivation is not blocked, then deactivate.
    for i, t in enumerate(tasks):
        target = users["m2"] if i % 2 else users["m1"]
        client.post(f"/api/tasks/{t['id']}/assign", headers=CSRF, json={"assignee_id": target})
    r = client.post(
        f"/api/users/{users['m1']}/deactivate",
        headers=CSRF,
        json={"reassign_to_user_id": users["m2"]},
    )
    assert r.status_code == 200
    for t in tasks:
        assert _running(t["id"]) == [], f"task {t['id']} kept a running timer"


# --- the ignored `days` parameter ---------------------------------------------


@pytest.mark.parametrize("endpoint", ["/api/dashboard/executive", "/api/dashboard/lead"])
def test_an_explicit_day_count_is_honoured(client, users, endpoint):
    """`?days=30` was validated and then discarded; only `period` did anything."""
    login(client, "lead@x.com")
    recent = client.get(f"{endpoint}?days=1").json()
    wide = client.get(f"{endpoint}?days=60").json()
    assert wide["period_label"] == "the last 60 days"
    assert recent["period_label"] == "the last 1 days"
    assert wide["range"]["from"] < recent["range"]["from"]


# --- login throttling -----------------------------------------------------------


def test_the_throttle_survives_a_new_process(client, users):
    """It used to be a module-level dict, so a restart wiped every counter."""
    login(client, "lead@x.com")
    bad = {"email": "lead@x.com", "password": "wrong-password"}
    for _ in range(5):
        assert client.post("/api/auth/login", json=bad).status_code == 401
    assert client.post("/api/auth/login", json=bad).status_code == 401
    assert (
        client.post("/api/auth/login", json=bad).json()["detail"]["code"]
        == "TOO_MANY_ATTEMPTS"
    )

    db = SessionLocal()
    try:
        stored = db.scalars(select(LoginAttempt)).all()
    finally:
        db.close()
    assert stored, "failures must be recorded in the database, not memory"


def test_one_address_cannot_spray_guesses_across_every_account(client, users):
    """A per-(email, ip) bucket alone let one host try one guess against every
    address in the company without ever tripping."""
    emails = [f"probe{i}@x.com" for i in range(30)]
    for email in emails:
        r = client.post("/api/auth/login", json={"email": email, "password": "wrong"})
        assert r.status_code == 401, email
    blocked = client.post(
        "/api/auth/login", json={"email": "never-seen@x.com", "password": "wrong"}
    )
    assert blocked.json()["detail"]["code"] == "TOO_MANY_ATTEMPTS"


def test_a_successful_sign_in_clears_only_that_account_s_bucket(client, users):
    login(client, "m1@x.com")
    for _ in range(3):
        client.post("/api/auth/login", json={"email": "m1@x.com", "password": "wrong"})
    assert client.post("/api/auth/login", json={"email": "m1@x.com", "password": "wrong"}).status_code == 401
    assert login(client, "m1@x.com").status_code == 200
    # Four more failures are allowed again, and the fifth is refused.
    # TOO_MANY_ATTEMPTS is a 401 too, so the code -- not the status -- is what
    # tells a refused guess from a wrong one.
    codes = [
        client.post("/api/auth/login", json={"email": "m1@x.com", "password": "wrong"}).json()["detail"]["code"]
        for _ in range(5)
    ]
    assert codes == ["INVALID_CREDENTIALS"] * 5
    blocked = client.post(
        "/api/auth/login", json={"email": "m1@x.com", "password": "wrong"}
    ).json()["detail"]["code"]
    assert blocked == "TOO_MANY_ATTEMPTS"


def test_stale_attempts_are_pruned(client, users):
    login(client, "lead@x.com")
    for _ in range(4):
        client.post("/api/auth/login", json={"email": "lead@x.com", "password": "wrong"})

    db = SessionLocal()
    try:
        stale = utcnow() - timedelta(hours=2)
        for row in db.scalars(select(LoginAttempt)).all():
            row.attempted_at = stale
        db.commit()
    finally:
        db.close()

    assert client.post("/api/auth/login", json={"email": "lead@x.com", "password": "wrong"}).status_code == 401
    db = SessionLocal()
    try:
        assert db.scalars(select(LoginAttempt)).all(), "old rows are pruned, recent ones are not"
    finally:
        db.close()


# --- query volume -----------------------------------------------------------------


def test_a_page_of_tasks_costs_a_fixed_number_of_queries(client, users):
    """`task_out` ran four queries per row, so a 25-row page issued roughly a
    hundred. The count must not grow with the page size."""
    from sqlalchemy import event

    login(client, "lead@x.com")
    for i in range(20):
        client.post("/api/tasks", headers=CSRF, json={"title": f"T{i:02d}"})

    counter = {"n": 0}

    def track(*_a, **_kw):
        counter["n"] += 1

    event.listen(engine, "before_cursor_execute", track)
    try:
        client.get("/api/tasks?page_size=5")
        small = counter["n"]
        counter["n"] = 0
        client.get("/api/tasks?page_size=20")
        large = counter["n"]
    finally:
        event.remove(engine, "before_cursor_execute", track)

    assert large < small * 2, f"queries scale with page size: {small} for 5, {large} for 20"