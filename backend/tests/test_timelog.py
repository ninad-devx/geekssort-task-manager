"""Gate suite: the core feature. Timers, manual entries, overrides, audit immutability."""

from __future__ import annotations

import sqlite3
from datetime import datetime, timedelta, timezone

from app.db import SessionLocal
from app.models import WorkSession
from tests.conftest import CSRF, login


def code(r) -> str:
    return r.json()["detail"]["code"]


def utc(**kw) -> str:
    return (datetime.now(timezone.utc) + timedelta(**kw)).strftime("%Y-%m-%dT%H:%M:%S")


def task_for(client, **kw):
    payload = {"title": "Work item"}
    payload.update(kw)
    return client.post("/api/tasks", headers=CSRF, json=payload).json()


def start(client, tid):
    return client.post(f"/api/tasks/{tid}/timer/start", headers=CSRF)


def edit_log(client, log_id, **kw):
    return client.patch(f"/api/logs/{log_id}", headers=CSRF, json=kw)


def events(client, tid):
    return client.get("/api/audit", params={"task_id": tid}).json()["items"]


def event_types(client, tid):
    return [e["event_type"] for e in events(client, tid)]


# --- start / pause ---------------------------------------------------------

def test_start_creates_running_session_and_moves_status(client, users):
    login(client, "lead@x.com")
    t = task_for(client, assignee_id=users["m1"])
    client.post("/api/auth/logout", headers=CSRF)
    login(client, "m1@x.com")

    r = start(client, t["id"])
    assert r.status_code == 200
    body = r.json()
    assert body["log"]["ended_at"] is None and body["log"]["source"] == "timer"
    assert body["task"]["status"] == "in_progress"
    assert body["paused_previous"] is None
    assert "start_timer" not in body["task"]["allowed_actions"]
    assert "pause_timer" in body["task"]["allowed_actions"]


def test_starting_a_timer_emits_exactly_one_status_event(client, users):
    login(client, "lead@x.com")
    t = task_for(client, assignee_id=users["m1"])
    client.post("/api/auth/logout", headers=CSRF)
    login(client, "m1@x.com")
    base = len(events(client, t["id"]))
    start(client, t["id"])
    types = event_types(client, t["id"])
    assert len(events(client, t["id"])) - base == 2  # timer.started + one status event
    assert types.count("task.status_changed") == 1


def test_timers_run_concurrently_across_tasks(client, users):
    """A person may genuinely work on two things at once.

    This replaces the old "one running timer per person" rule, which closed the
    previous session every time the person switched task. The invariant that
    survives is one running timer per *task*.
    """
    login(client, "lead@x.com")
    a = task_for(client, title="A", assignee_id=users["m1"])
    b = task_for(client, title="B", assignee_id=users["m1"])
    client.post("/api/auth/logout", headers=CSRF)
    login(client, "m1@x.com")

    first = start(client, a["id"]).json()["log"]
    second = start(client, b["id"]).json()
    assert second["log"]["task_id"] == b["id"]
    # starting B must not have closed A
    assert second["paused_previous"] is None

    running = client.get("/api/timer/current").json()["running"]
    assert {r["task_id"] for r in running} == {a["id"], b["id"]}

    # each timer is paused independently, by log id
    client.post("/api/timer/pause", headers=CSRF, json={"log_id": first["id"]})
    still = client.get("/api/timer/current").json()["running"]
    assert [r["task_id"] for r in still] == [b["id"]]


def test_starting_the_same_timer_twice_conflicts(client, users):
    login(client, "lead@x.com")
    t = task_for(client, assignee_id=users["m1"])
    client.post("/api/auth/logout", headers=CSRF)
    login(client, "m1@x.com")
    start(client, t["id"])
    r = start(client, t["id"])
    assert r.status_code == 409 and code(r) == "TIMER_ALREADY_RUNNING"


def test_cannot_track_time_on_another_persons_task(client, users):
    login(client, "lead@x.com")
    t = task_for(client, assignee_id=users["m1"])
    client.post("/api/auth/logout", headers=CSRF)
    login(client, "m2@x.com")
    assert start(client, t["id"]).status_code == 404


def test_pause_with_no_running_timer_is_409(client, users):
    login(client, "m1@x.com")
    r = client.post("/api/timer/pause", headers=CSRF, json={})
    assert r.status_code == 409 and code(r) == "NO_RUNNING_TIMER"


def test_pause_computes_duration_and_note_and_progress(client, users):
    login(client, "lead@x.com")
    t = task_for(client, assignee_id=users["m1"])
    client.post("/api/auth/logout", headers=CSRF)
    login(client, "m1@x.com")
    start(client, t["id"])
    r = client.post("/api/timer/pause", headers=CSRF, json={"note": "Drafted the post", "progress_percent": 60}).json()
    assert r["log"]["ended_at"] is not None
    assert r["log"]["duration_seconds"] >= 0
    assert r["log"]["note"] == "Drafted the post"
    assert r["task"]["progress_percent"] == 60
    assert r["adjusted"] is False


def test_timer_survives_relogin(client, users):
    """FR-TIME-006: closing the browser does not stop the timer."""
    from fastapi.testclient import TestClient

    from app.main import app

    login(client, "lead@x.com")
    t = task_for(client, assignee_id=users["m1"])
    client.post("/api/auth/logout", headers=CSRF)

    first = TestClient(app)
    first.post("/api/auth/login", json={"email": "m1@x.com", "password": "Str0ngPassphrase!"})
    first.post(f"/api/tasks/{t['id']}/timer/start", headers=CSRF)

    second = TestClient(app)
    second.post("/api/auth/login", json={"email": "m1@x.com", "password": "Str0ngPassphrase!"})
    running = second.get("/api/timer/current").json()["running"]
    assert len(running) == 1 and running[0]["task_id"] == t["id"]


def test_completed_task_cannot_be_tracked(client, users):
    login(client, "lead@x.com")
    t = task_for(client, assignee_id=users["m1"])
    client.post("/api/tasks/%d/status" % t["id"], headers=CSRF, json={"status": "completed"})
    client.post("/api/auth/logout", headers=CSRF)
    login(client, "m1@x.com")
    assert start(client, t["id"]).status_code == 409


# --- adjusted pause --------------------------------------------------------

def test_adjusted_end_time_sets_flag(client, users):
    """An end time more than 60s from now is flagged adjusted (FR-TIME-003)."""
    login(client, "lead@x.com")
    t = task_for(client, assignee_id=users["m1"])
    client.post("/api/auth/logout", headers=CSRF)
    login(client, "m1@x.com")
    start(client, t["id"])
    r = client.post("/api/timer/pause", headers=CSRF, json={"ended_at": utc(minutes=5)})
    assert r.status_code == 200 and r.json()["adjusted"] is True
    paused = [e for e in events(client, t["id"]) if e["event_type"] == "timer.paused"]
    assert paused and paused[0]["meta"]["adjusted"] is True


def test_unadjusted_pause_has_no_flag(client, users):
    login(client, "m1@x.com")
    t = task_for(client)
    start(client, t["id"])
    r = client.post("/api/timer/pause", headers=CSRF, json={})
    assert r.json()["adjusted"] is False


def test_end_time_in_the_future_is_clamped(client, users):
    login(client, "m1@x.com")
    t = task_for(client)
    start(client, t["id"])
    r = client.post("/api/timer/pause", headers=CSRF, json={"ended_at": utc(hours=2)})
    assert r.status_code == 200
    assert r.json()["log"]["ended_at"] is not None


def test_end_time_before_start_is_422(client, users):
    login(client, "m1@x.com")
    t = task_for(client)
    start(client, t["id"])
    r = client.post("/api/timer/pause", headers=CSRF, json={"ended_at": utc(hours=-3)})
    assert r.status_code == 422


# --- manual entries --------------------------------------------------------

def add_manual(client, tid, **kw):
    body = {"entry_type": "work_session", "started_at": utc(hours=-3)}
    body.update(kw)
    return client.post(f"/api/tasks/{tid}/logs", headers=CSRF, json=body)


def test_manual_entry_with_duration(client, users):
    login(client, "m1@x.com")
    t = task_for(client)
    r = add_manual(client, t["id"], duration_minutes=90, note="wrote the brief")
    assert r.status_code == 201
    log = r.json()
    assert log["source"] == "manual" and log["duration_seconds"] == 5400
    assert client.get(f"/api/tasks/{t['id']}").json()["tracked_seconds"] == 5400


def test_manual_entry_requires_end_or_duration(client, users):
    login(client, "m1@x.com")
    t = task_for(client)
    r = add_manual(client, t["id"])
    assert r.status_code == 422 and code(r) == "ENDED_AT_REQUIRED"


def test_overlapping_entries_are_rejected(client, users):
    login(client, "m1@x.com")
    t = task_for(client)
    assert add_manual(client, t["id"], started_at=utc(hours=-4), ended_at=utc(hours=-2)).status_code == 201
    r = add_manual(client, t["id"], started_at=utc(hours=-3), ended_at=utc(hours=-1))
    assert r.status_code == 409 and code(r) == "TIME_OVERLAP"
    assert "conflicting_log_id" in r.json()["detail"]


def test_overlap_with_a_running_timer_counts_as_ending_now(client, users):
    """A running session counts as ending now, so a later entry clashes with it."""
    import time as _t

    login(client, "m1@x.com")
    t = task_for(client)
    start(client, t["id"])
    _t.sleep(0.05)  # ensure the running session started strictly before "now"
    r = add_manual(client, t["id"], started_at=utc(minutes=-30), ended_at=utc(seconds=1))
    assert r.status_code == 409 and code(r) == "TIME_OVERLAP"


def test_note_entry(client, users):
    login(client, "m1@x.com")
    t = task_for(client)
    r = client.post(f"/api/tasks/{t['id']}/logs", headers=CSRF, json={
        "entry_type": "note", "started_at": utc(hours=-1), "note": "Blocked on legal review",
    })
    assert r.status_code == 201 and r.json()["entry_type"] == "note"
    assert r.json()["duration_seconds"] == 0


def test_note_requires_text(client, users):
    login(client, "m1@x.com")
    t = task_for(client)
    r = client.post(f"/api/tasks/{t['id']}/logs", headers=CSRF, json={
        "entry_type": "note", "started_at": utc(hours=-1), "note": "  ",
    })
    assert r.status_code == 422


def test_unsafe_evidence_url_is_rejected(client, users):
    login(client, "m1@x.com")
    t = task_for(client)
    for bad in ["javascript:alert(1)", "data:text/html,<script>", "file:///etc/passwd", "ftp://x.com/f"]:
        r = add_manual(client, t["id"], started_at=utc(hours=-6), ended_at=utc(hours=-5), evidence_url=bad)
        assert r.status_code == 422, bad


# --- override: edit --------------------------------------------------------

def test_author_can_edit_own_entry_with_audit(client, users):
    login(client, "m1@x.com")
    t = task_for(client)
    log = add_manual(client, t["id"], started_at=utc(hours=-4), ended_at=utc(hours=-2)).json()
    r = client.patch(f"/api/logs/{log['id']}", headers=CSRF, json={
        "started_at": utc(hours=-3, minutes=-30), "edit_reason": "started after standup",
    })
    assert r.status_code == 200
    edited = r.json()
    assert edited["edit_count"] == 1 and edited["edited_at"] is not None
    # start moved from -4h to -3h30, so the duration shrank from 2h to 1h30
    assert edited["duration_seconds"] == 5400 < log["duration_seconds"]

    found = [e for e in events(client, t["id"]) if e["event_type"] == "log.edited"]
    assert len(found) == 1
    assert found[0]["before"]["started_at"] != found[0]["after"]["started_at"]
    assert found[0]["meta"]["edit_reason"] == "started after standup"


def test_nobody_can_edit_another_persons_entry(client, users):
    login(client, "lead@x.com")
    t = task_for(client, assignee_id=users["m1"])
    client.post("/api/auth/logout", headers=CSRF)
    login(client, "m1@x.com")
    log = add_manual(client, t["id"], started_at=utc(hours=-4), ended_at=utc(hours=-2)).json()
    client.post("/api/auth/logout", headers=CSRF)
    login(client, "lead@x.com")
    r = client.patch(f"/api/logs/{log['id']}", headers=CSRF, json={"note": "tampered"})
    assert r.status_code == 403 and code(r) == "NOT_LOG_AUTHOR"
    login(client, "m2@x.com")
    assert client.patch(f"/api/logs/{log['id']}", headers=CSRF, json={"note": "tampered"}).status_code == 404


def test_edit_rejects_overlap(client, users):
    login(client, "m1@x.com")
    t = task_for(client)
    add_manual(client, t["id"], started_at=utc(hours=-6), ended_at=utc(hours=-5))
    second = add_manual(client, t["id"], started_at=utc(hours=-3), ended_at=utc(hours=-1)).json()
    r = client.patch(f"/api/logs/{second['id']}", headers=CSRF, json={"started_at": utc(hours=-7)})
    assert r.status_code == 409 and code(r) == "TIME_OVERLAP"


def test_running_entry_cannot_be_closed_by_edit(client, users):
    login(client, "m1@x.com")
    t = task_for(client)
    running = start(client, t["id"]).json()["log"]
    r = client.patch(f"/api/logs/{running['id']}", headers=CSRF, json={
        "ended_at": utc(hours=-1), "if_ended_at_unchanged": False,
    })
    assert r.status_code == 409 and code(r) == "USE_PAUSE"


def test_running_entry_can_be_retexted(client, users):
    login(client, "m1@x.com")
    t = task_for(client)
    running = start(client, t["id"]).json()["log"]
    r = client.patch(f"/api/logs/{running['id']}", headers=CSRF, json={"note": "still going"})
    assert r.status_code == 200 and r.json()["ended_at"] is None


# --- override: delete ------------------------------------------------------

def test_delete_is_soft_and_audited(client, users):
    login(client, "m1@x.com")
    t = task_for(client)
    log = add_manual(client, t["id"], started_at=utc(hours=-4), ended_at=utc(hours=-2)).json()
    r = client.delete(f"/api/logs/{log['id']}", headers=CSRF)
    assert r.status_code == 200 and r.json()["deleted_at"] is not None
    assert client.get(f"/api/tasks/{t['id']}").json()["tracked_seconds"] == 0
    found = [e for e in events(client, t["id"]) if e["event_type"] == "log.deleted"]
    assert len(found) == 1 and found[0]["before"]["id"] == log["id"]


def test_management_sees_deleted_entries(client, users):
    login(client, "lead@x.com")
    t = task_for(client, assignee_id=users["m1"])
    client.post("/api/auth/logout", headers=CSRF)
    login(client, "m1@x.com")
    log = add_manual(client, t["id"], started_at=utc(hours=-4), ended_at=utc(hours=-2)).json()
    client.delete(f"/api/logs/{log['id']}", headers=CSRF)
    client.post("/api/auth/logout", headers=CSRF)
    login(client, "lead@x.com")
    rows = client.get(f"/api/tasks/{t['id']}/logs", params={"include_deleted": True}).json()
    assert [r["id"] for r in rows] == [log["id"]]


def test_discarding_a_running_timer(client, users):
    login(client, "m1@x.com")
    t = task_for(client)
    running = start(client, t["id"]).json()["log"]
    r = client.delete(f"/api/logs/{running['id']}", headers=CSRF)
    assert r.status_code == 200
    assert client.get("/api/timer/current").json()["running"] == []


# --- auto close ------------------------------------------------------------

def test_completion_closes_a_running_timer(client, users):
    login(client, "m1@x.com")
    t = task_for(client)
    start(client, t["id"])
    r = client.post(f"/api/tasks/{t['id']}/status", headers=CSRF, json={"status": "completed"})
    assert r.status_code == 200
    logs = client.get(f"/api/tasks/{t['id']}/logs").json()
    assert logs[0]["ended_at"] is not None
    assert client.get("/api/timer/current").json()["running"] == []
    paused = [e for e in events(client, t["id"]) if e["event_type"] == "timer.paused"]
    assert paused and paused[0]["meta"]["auto"] is True


def test_blocking_closes_a_running_timer(client, users):
    login(client, "m1@x.com")
    t = task_for(client)
    start(client, t["id"])
    client.post(f"/api/tasks/{t['id']}/status", headers=CSRF, json={"status": "blocked", "reason": "no assets"})
    assert client.get("/api/timer/current").json()["running"] == []


def test_reassign_closes_a_running_timer(client, users):
    login(client, "lead@x.com")
    t = task_for(client, assignee_id=users["m1"])
    client.post("/api/auth/logout", headers=CSRF)
    login(client, "m1@x.com")
    start(client, t["id"])
    client.post("/api/auth/logout", headers=CSRF)
    login(client, "lead@x.com")
    client.post(f"/api/tasks/{t['id']}/assign", headers=CSRF, json={"assignee_id": users["m2"]})
    logs = client.get(f"/api/tasks/{t['id']}/logs").json()
    assert logs[0]["ended_at"] is not None


# --- totals ----------------------------------------------------------------

def test_tracked_seconds_excludes_deleted_and_running(client, users):
    login(client, "m1@x.com")
    t = task_for(client)
    keep = add_manual(client, t["id"], started_at=utc(hours=-6), ended_at=utc(hours=-5)).json()
    gone = add_manual(client, t["id"], started_at=utc(hours=-9), ended_at=utc(hours=-8)).json()
    client.delete(f"/api/logs/{gone['id']}", headers=CSRF)
    start(client, t["id"])
    detail = client.get(f"/api/tasks/{t['id']}").json()
    assert detail["tracked_seconds"] == keep["duration_seconds"]
    assert detail["running"] is not None
    assert detail["running"]["elapsed_seconds"] >= 0


def test_partial_unique_index_blocks_two_running_sessions_on_one_task(client, users):
    """The database guarantees one running timer per task, per person.

    Timers are otherwise concurrent, so the index is on (user_id, task_id)
    rather than user_id alone.
    """
    login(client, "m1@x.com")
    t = task_for(client)
    start(client, t["id"])
    db = SessionLocal()
    try:
        db.add(WorkSession(
            task_id=t["id"], user_id=users["m1"], started_at=datetime.utcnow(), created_at=datetime.utcnow()
        ))
        from sqlalchemy.exc import IntegrityError

        try:
            db.commit()
            raise AssertionError("partial unique index did not block a second running session")
        except IntegrityError:
            db.rollback()
    finally:
        db.close()


# --- audit immutability ----------------------------------------------------

def test_audit_events_cannot_be_updated_or_deleted(client, users):
    login(client, "m1@x.com")
    t = task_for(client)
    add_manual(client, t["id"], started_at=utc(hours=-4), ended_at=utc(hours=-2))
    from app.config import settings

    raw = sqlite3.connect(settings.DATABASE_URL.replace("sqlite:///", ""))
    try:
        assert raw.execute("SELECT count(*) FROM audit_events").fetchone()[0] > 0
        for sql in ("UPDATE audit_events SET summary='x'", "DELETE FROM audit_events"):
            try:
                raw.execute(sql)
                raise AssertionError(f"audit_events was mutable: {sql}")
            except sqlite3.IntegrityError:
                pass
    finally:
        raw.close()


def test_no_endpoint_exposes_audit_mutation(client, users):
    login(client, "lead@x.com")
    for path, method in (
        ("/api/audit", "put"),
        ("/api/audit/1", "delete"),
        ("/api/audit/1", "patch"),
    ):
        r = client.request(method.upper(), path, headers=CSRF, json={})
        assert r.status_code in (404, 405), path


def test_request_id_is_shared_by_events_of_one_request(client, users):
    """Starting a timer on a todo task writes two events; both share one request_id."""
    login(client, "lead@x.com")
    t = task_for(client, assignee_id=users["m1"])
    client.post("/api/auth/logout", headers=CSRF)
    login(client, "m1@x.com")
    start(client, t["id"])
    rows = [e for e in events(client, t["id"]) if e["event_type"] != "task.created"]
    assert len(rows) == 2
    assert rows[0]["request_id"] == rows[1]["request_id"]
    assert {rows[0]["event_type"], rows[1]["event_type"]} == {"timer.started", "task.status_changed"}


def test_never_returns_password_hash_or_token(client, users):
    login(client, "lead@x.com")
    me = client.get("/api/auth/me")
    assert "password_hash" not in me.text and "token" not in me.text.lower()
    assert client.get("/api/users").text.count("password_hash") == 0


def test_audit_records_actor_and_utc_timestamp(client, users):
    login(client, "m1@x.com")
    t = task_for(client)
    add_manual(client, t["id"], started_at=utc(hours=-4), ended_at=utc(hours=-2))
    row = events(client, t["id"])[0]
    assert row["actor_name"] == "Member One"
    assert row["created_at"].endswith("Z") or "T" in row["created_at"]