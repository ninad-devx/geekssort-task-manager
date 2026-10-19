"""A list row must offer exactly the status changes the server will accept.

The request behind this: nobody should have to open a task to move it. That
means a status control on the row, and the control has to be built from the same
transition table the endpoint enforces -- not from a second copy of the rules in
the client. A client-side copy offers moves that come back 409 INVALID_TRANSITION
or 403 REVIEW_REQUIRED, which is worse than offering nothing at all.

These tests assert the payload the row renders from.
"""

from __future__ import annotations

from tests.conftest import CSRF, login


def _task(client, **kw):
    payload = {"title": "Work item"}
    payload.update(kw)
    return client.post("/api/tasks", headers=CSRF, json=payload).json()


def _moves(task: dict) -> list[str]:
    return [m["status"] for m in task["allowed_statuses"]]


def test_a_fresh_todo_task_offers_the_legal_moves(client, users):
    login(client, "m1@x.com")
    task = _task(client)
    # SRS 10.2: todo -> in_progress, blocked, completed. And nothing else.
    assert _moves(task) == ["in_progress", "blocked", "completed"]


def test_moves_are_ordered_the_way_the_board_reads(client, users):
    """Not dict order. To Do -> In Progress -> In Review -> Blocked -> Done."""
    login(client, "m1@x.com")
    t = _task(client)
    client.post(f"/api/tasks/{t['id']}/status", headers=CSRF, json={"status": "in_progress"})
    listed = client.get("/api/tasks?mine=1&scope=open").json()["items"][0]
    assert _moves(listed) == ["todo", "blocked", "in_review", "completed"]


def test_a_move_that_needs_a_reason_says_so_up_front(client, users):
    login(client, "m1@x.com")
    task = _task(client)
    blocked = next(m for m in task["allowed_statuses"] if m["status"] == "blocked")
    assert blocked["requires_reason"] is True
    assert blocked["requires_note"] is False
    # The server enforces it, so the row is not the only line of defence.
    r = client.post(f"/api/tasks/{task['id']}/status", headers=CSRF, json={"status": "blocked"})
    assert r.status_code == 409


def test_a_reopen_needs_a_note(client, users):
    login(client, "m1@x.com")
    t = _task(client)
    client.post(f"/api/tasks/{t['id']}/status", headers=CSRF, json={"status": "completed"})

    fresh = client.get(f"/api/tasks/{t['id']}").json()
    back = next(m for m in fresh["allowed_statuses"] if m["status"] == "in_progress")
    assert back["requires_note"] is True
    assert back["requires_reason"] is False
    # And the server refuses the bare click, so the note is not merely advisory.
    bare = client.post(f"/api/tasks/{t['id']}/status", headers=CSRF, json={"status": "in_progress"})
    assert bare.status_code == 409


def test_review_required_hides_complete_from_somebody_who_cannot_do_it(client, users):
    """A lead set `requires_review`; the assignee must not see a Complete button
    that is guaranteed to fail."""
    login(client, "lead@x.com")
    t = _task(client, assignee_id=users["m1"], requires_review=True)
    assert "completed" in _moves(t), "a lead is allowed to approve"

    login(client, "m1@x.com")
    as_member = client.get(f"/api/tasks/{t['id']}").json()
    assert "completed" not in _moves(as_member)
    assert "in_progress" in _moves(as_member), "they can still start work on it"


def test_the_bar_never_appears_without_permission(client, users):
    """The contract the row relies on.

    `allowed_statuses` empty is what hides the control, so it must hold exactly
    when `change_status` is absent -- for a deleted task, and for every actor.
    A control shown next to a task the endpoint would refuse is the bug this
    whole file exists to prevent.
    """
    login(client, "lead@x.com")
    t = _task(client, assignee_id=users["m1"])
    login(client, "m1@x.com")
    client.post(f"/api/tasks/{t['id']}/status", headers=CSRF, json={"status": "blocked", "reason": "waiting"})

    for email in ("m1@x.com", "ceo@x.com", "lead@x.com", "m2@x.com"):
        login(client, email)
        resp = client.get(f"/api/tasks/{t['id']}")
        if resp.status_code == 404:
            # Cannot read the task at all, so certainly no control.
            continue
        body = resp.json()
        assert bool(body["allowed_statuses"]) == ("change_status" in body["allowed_actions"]), email

    login(client, "lead@x.com")
    client.delete(f"/api/tasks/{t['id']}", headers=CSRF)
    deleted = client.get(f"/api/tasks/{t['id']}").json()
    assert deleted["allowed_statuses"] == []
    assert deleted["allowed_actions"] == ["restore"]


def test_the_row_and_the_endpoint_agree_on_every_step(client, users):
    """Walk a task through the machine and check the bar never offers a 409."""
    login(client, "m1@x.com")
    task = _task(client)
    seen = 0
    for _ in range(6):
        current = client.get(f"/api/tasks/{task['id']}").json()
        if not current["allowed_statuses"]:
            break
        move = current["allowed_statuses"][0]
        payload = {"status": move["status"]}
        if move["requires_reason"]:
            payload["reason"] = "waiting on input"
        if move["requires_note"]:
            payload["note"] = "reopening for context"
        r = client.post(f"/api/tasks/{task['id']}/status", headers=CSRF, json=payload)
        assert r.status_code == 200, f"{move['status']} was offered but rejected: {r.text}"
        seen += 1
    assert seen >= 3, "a real walk must move more than once"