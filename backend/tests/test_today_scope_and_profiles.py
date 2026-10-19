"""A day must read as a day.

The complaint these cover: opening the app in the morning showed a list that
started at task #37 from the previous day's work, a dashboard whose completed
and tracked-hour cards were describing last week, and a tracked-time page that
only ever reported a rolling company total. Three separate questions were being
answered with "everything, ever".

The rule the whole suite now encodes: *today* means overdue carry-forward, due
today, and work somebody is actively on -- ordered by what needs a person first.
It never means the whole backlog.
"""

from __future__ import annotations

from datetime import date, datetime, timedelta, timezone

from app.models import utcnow
from tests.conftest import CSRF, login


def today_str() -> str:
    return date.today().isoformat()


def _task(client, **kw):
    payload = {"title": "Work item"}
    payload.update(kw)
    return client.post("/api/tasks", headers=CSRF, json=payload).json()


def _log(client, task_id, hours_ago, hours):
    """Log time as whoever is currently signed in.

    `can_track_time` only lets the assignee record against their own task, and
    `ended_at` in the future is rejected outright -- so a helper that quietly
    logs as whoever happens to be logged in produces zero entries and a test that
    passes for the wrong reason.
    """
    assert hours <= hours_ago, "a manual entry may not end in the future"
    response = client.post(
        f"/api/tasks/{task_id}/logs",
        headers=CSRF,
        json={
            "started_at": (datetime.now(timezone.utc) - timedelta(hours=hours_ago)).strftime(
                "%Y-%m-%dT%H:%M:%S"
            ),
            "ended_at": (
                datetime.now(timezone.utc) - timedelta(hours=hours_ago - hours)
            ).strftime("%Y-%m-%dT%H:%M:%S"),
        },
    )
    assert response.status_code == 201, response.text
    return response


def _switch(client, email):
    client.post("/api/auth/logout", headers=CSRF)
    assert login(client, email).status_code == 200


def _make_backlog(client, assignee_id):
    """The shape that used to be all a person ever saw: old work piled up."""
    old = _task(client, title="Ancient backlog", assignee_id=assignee_id, due_date="2020-01-01")
    future = _task(
        client, title="Someday", assignee_id=assignee_id, due_date="2099-01-01"
    )
    yesterday = _task(
        client,
        title="Slipped from yesterday",
        assignee_id=assignee_id,
        due_date=(date.today() - timedelta(days=1)).isoformat(),
    )
    today = _task(client, title="Due today", assignee_id=assignee_id, due_date=today_str())
    client.post(f"/api/tasks/{today['id']}/status", headers=CSRF, json={"status": "in_progress"})
    return old, future, yesterday, today


# --- /tasks?scope=today ----------------------------------------------------

def test_today_scope_carries_overdue_and_hides_the_deep_backlog(client, users):
    login(client, "lead@x.com")
    old, future, yesterday, today = _make_backlog(client, users["m1"])

    login(client, "m1@x.com")
    listed = client.get("/api/tasks?mine=1&scope=today").json()
    ids = [t["id"] for t in listed["items"]]

    assert today["id"] in ids
    assert yesterday["id"] in ids, "work that was due before today and is still open is today's work"
    assert old["id"] not in ids, "a backlog from years ago is not what today means"
    assert future["id"] not in ids, "something due next year is not due today"
    assert listed["total"] == 2


def test_today_scope_reports_the_backlog_it_left_out(client, users):
    """Narrowing the list must not look like the backlog was dealt with."""
    login(client, "lead@x.com")
    old, future, yesterday, today = _make_backlog(client, users["m1"])

    login(client, "m1@x.com")
    summary = client.get("/api/tasks?mine=1&scope=today").json()["summary"]
    assert summary["carry_days"] == 7
    assert summary["older_overdue"] == 1, "the 2020 task is older than the carry-forward window"
    assert summary["overdue"] == 1, "only yesterday's slip counts as today's problem"


def test_the_carry_forward_window_is_adjustable(client, users):
    login(client, "lead@x.com")
    ten_days = _task(
        client,
        title="Slipped ten days",
        assignee_id=users["m1"],
        due_date=(date.today() - timedelta(days=10)).isoformat(),
    )

    login(client, "m1@x.com")
    default_ids = [t["id"] for t in client.get("/api/tasks?mine=1&scope=today").json()["items"]]
    assert ten_days["id"] not in default_ids

    widened = client.get("/api/tasks?mine=1&scope=today&carry_days=30").json()
    assert ten_days["id"] in [t["id"] for t in widened["items"]]
    assert widened["summary"]["carry_days"] == 30

    narrowed = client.get("/api/tasks?mine=1&scope=today&carry_days=0").json()
    assert narrowed["total"] == 0


def test_today_scope_is_ordered_by_what_needs_a_person_first(client, users):
    login(client, "lead@x.com")
    overdue = _task(
        client,
        title="Overdue",
        assignee_id=users["m1"],
        due_date=(date.today() - timedelta(days=5)).isoformat(),
        priority="low",
    )
    active = _task(
        client, title="In flight", assignee_id=users["m1"], due_date="2099-06-01", priority="low"
    )
    client.post(f"/api/tasks/{active['id']}/status", headers=CSRF, json={"status": "in_progress"})
    due_today = _task(client, title="Due today", assignee_id=users["m1"], due_date=today_str())

    login(client, "m1@x.com")
    ids = [t["id"] for t in client.get("/api/tasks?mine=1&scope=today").json()["items"]]
    # Overdue beats actively-moved work beats merely-due-today, whatever the
    # priority column says -- otherwise a "low priority" slippage is the last
    # thing anybody reads.
    assert ids.index(overdue["id"]) < ids.index(active["id"]) < ids.index(due_today["id"])


def test_today_scope_includes_what_was_finished_today(client, users):
    login(client, "lead@x.com")
    t = _task(client, title="Finished today", assignee_id=users["m1"])
    client.post(f"/api/tasks/{t['id']}/status", headers=CSRF, json={"status": "in_progress"})
    client.post(f"/api/tasks/{t['id']}/status", headers=CSRF, json={"status": "completed"})

    login(client, "m1@x.com")
    titles = [i["title"] for i in client.get("/api/tasks?mine=1&scope=today").json()["items"]]
    assert "Finished today" in titles


def test_open_and_done_scopes_are_mutually_exclusive(client, users):
    login(client, "lead@x.com")
    live = _task(client, title="Live", assignee_id=users["m1"])
    done = _task(client, title="Done", assignee_id=users["m1"])
    client.post(f"/api/tasks/{done['id']}/status", headers=CSRF, json={"status": "completed"})

    login(client, "m1@x.com")
    open_ids = [t["id"] for t in client.get("/api/tasks?mine=1&scope=open").json()["items"]]
    done_ids = [t["id"] for t in client.get("/api/tasks?mine=1&scope=done").json()["items"]]
    assert live["id"] in open_ids and done["id"] not in open_ids
    assert done["id"] in done_ids and live["id"] not in done_ids


def test_no_scope_still_returns_everything(client, users):
    """The default is untouched: existing callers and the board must not shift."""
    login(client, "lead@x.com")
    old, future, yesterday, today = _make_backlog(client, users["m1"])

    login(client, "m1@x.com")
    ids = [t["id"] for t in client.get("/api/tasks?mine=1").json()["items"]]
    assert set(ids) == {old["id"], future["id"], yesterday["id"], today["id"]}


def test_board_accepts_the_same_today_scope(client, users):
    login(client, "lead@x.com")
    _make_backlog(client, users["m1"])
    board = client.get("/api/tasks/board?scope=today").json()
    titles = [t["title"] for p in board["people"] for t in p["tasks"]]
    assert "Due today" in titles and "Slipped from yesterday" in titles
    assert "Ancient backlog" not in titles and "Someday" not in titles


# --- summary counts --------------------------------------------------------

def test_list_summary_counts_the_whole_filter_not_the_page(client, users):
    """The KPI strip used to tally the rows it happened to render."""
    login(client, "lead@x.com")
    for i in range(3):
        _task(client, title=f"Live {i}", assignee_id=users["m1"], due_date=today_str())
    old = _task(
        client,
        title="Slipped",
        assignee_id=users["m1"],
        due_date=(date.today() - timedelta(days=3)).isoformat(),
    )

    login(client, "m1@x.com")
    body = client.get("/api/tasks?mine=1&page_size=2").json()
    assert body["total"] == 4
    assert body["summary"]["total"] == 4
    assert body["summary"]["due_today"] == 3
    assert body["summary"]["overdue"] == 1
    assert old["id"] in {t["id"] for t in body["items"]}


# --- dashboard period=today ------------------------------------------------

def test_dashboard_today_does_not_report_the_whole_backlog(client, users):
    login(client, "lead@x.com")
    _make_backlog(client, users["m1"])
    _task(client, title="Unassigned ancient", due_date="2019-05-05")

    login(client, "m1@x.com")
    body = client.get("/api/dashboard/personal?period=today").json()
    assert body["counts"]["scope"] == "today"
    assert body["counts"]["total"] == 2, "overdue plus due today, not the backlog"
    assert body["counts"]["all_time_total"] == 4


def test_dashboard_wider_periods_keep_the_standing_totals(client, users):
    login(client, "lead@x.com")
    _make_backlog(client, users["m1"])

    login(client, "m1@x.com")
    body = client.get("/api/dashboard/personal?period=week").json()
    assert body["counts"]["scope"] == "all"
    assert body["counts"]["total"] == 4


def test_daily_bars_include_the_days_with_nothing_logged(client, users):
    """A dropped day reads as "no data" rather than "nothing done"."""
    login(client, "m1@x.com")
    t = _task(client, title="Something")
    _log(client, t["id"], 2, 1)

    daily = client.get("/api/dashboard/personal?period=week").json()["daily"]
    assert len(daily) == 7
    assert [d["day"] for d in daily] == sorted(d["day"] for d in daily)
    assert daily[-1]["day"] == today_str()
    assert daily[-1]["seconds"] > 0
    assert sum(1 for d in daily if d["seconds"] == 0) == 6
    assert all("completed" in d for d in daily)


# --- tracked time ----------------------------------------------------------

def test_days_1_is_today_alone(client, users):
    login(client, "lead@x.com")
    t = _task(client, title="Today work", assignee_id=users["m1"])
    _switch(client, "m1@x.com")
    _log(client, t["id"], 3, 1)

    today_hours = client.get("/api/time/summary?days=1").json()
    assert today_hours["total_seconds"] >= 3600
    # The window it actually summed is reported, so "Today" on the page cannot
    # quietly mean something else.
    assert today_hours["range"]["from"][:10] == today_str()


def test_yesterdays_hours_are_not_todays(client, users):
    """The window boundary is what makes "Today" mean today."""
    login(client, "lead@x.com")
    t = _task(client, title="Yesterday work", assignee_id=users["m1"])
    _switch(client, "m1@x.com")
    started = utcnow() - timedelta(days=1, hours=1)
    client.post(
        f"/api/tasks/{t['id']}/logs",
        headers=CSRF,
        json={
            "started_at": started.strftime("%Y-%m-%dT%H:%M:%S"),
            "ended_at": (started + timedelta(hours=1)).strftime("%Y-%m-%dT%H:%M:%S"),
        },
    )

    assert client.get("/api/time/summary?days=1").json()["total_seconds"] == 0
    assert client.get("/api/time/summary?days=2").json()["total_seconds"] >= 3600


def test_a_lead_can_filter_tracked_time_to_one_person(client, users):
    login(client, "lead@x.com")
    mine = _task(client, title="Lead work", assignee_id=users["lead"])
    _log(client, mine["id"], 2, 1)
    _switch(client, "m1@x.com")
    theirs = _task(client, title="Member work")
    _log(client, theirs["id"], 2, 1)
    _switch(client, "lead@x.com")

    everyone = client.get("/api/time/summary?days=7").json()
    assert everyone["scope"] == "company"
    assert {p["user"]["id"] for p in everyone["people"]} == {users["lead"], users["m1"]}

    just_one = client.get(f"/api/time/summary?days=7&user_id={users['m1']}").json()
    assert [p["user"]["id"] for p in just_one["people"]] == [users["m1"]]
    assert just_one["total_seconds"] < everyone["total_seconds"]


def test_a_member_asking_for_a_colleagues_time_gets_their_own(client, users):
    """`user_id` is simply not honoured for a member; it must not leak."""
    login(client, "lead@x.com")
    theirs = _task(client, title="Member work", assignee_id=users["m1"])
    _switch(client, "m1@x.com")
    _log(client, theirs["id"], 2, 1)

    body = client.get(f"/api/time/summary?days=7&user_id={users['m2']}").json()
    assert body["scope"] == "self"
    assert [p["user"]["id"] for p in body["people"]] == [users["m1"]]


# --- per-user profile ------------------------------------------------------

def test_a_member_may_open_their_own_profile(client, users):
    login(client, "m1@x.com")
    t = _task(client, title="Mine")
    _log(client, t["id"], 3, 2)

    body = client.get(f"/api/users/{users['m1']}/profile?days=7").json()
    assert body["is_self"] is True
    assert body["counts"]["tracked_seconds"] >= 7200
    assert body["counts"]["total"] >= 1
    assert len(body["daily"]) == 7
    assert body["daily"][-1]["day"] == today_str()


def test_a_member_cannot_read_a_colleagues_profile(client, users):
    """404, not 403 -- member ids must not be enumerable (rule D-10)."""
    login(client, "m1@x.com")
    assert client.get(f"/api/users/{users['m2']}/profile").status_code == 404


def test_a_lead_can_read_anyones_profile(client, users):
    login(client, "lead@x.com")
    t = _task(client, title="Carried by m1", assignee_id=users["m1"], due_date=today_str())
    body = client.get(f"/api/users/{users['m1']}/profile?days=30").json()
    assert body["is_self"] is False
    assert body["counts"]["due_today"] == 1
    assert [row["id"] for row in body["tasks"]["due_today"]] == [t["id"]]
    # The day-by-day strip is dense and ends today.
    assert len(body["daily"]) == 30
    assert body["daily"][-1]["day"] == today_str()


def test_the_ceo_profile_agrees_with_the_team_board_about_the_same_person(client, users):
    """One set of numbers, read two ways."""
    login(client, "lead@x.com")
    _task(client, title="A", assignee_id=users["m1"], due_date=today_str())
    _task(client, title="B", assignee_id=users["m1"], due_date=today_str())

    board = client.get("/api/tasks/board?assignee_id=%d&scope=today" % users["m1"]).json()
    person = next(p for p in board["people"] if p["user"]["id"] == users["m1"])
    profile = client.get(f"/api/users/{users['m1']}/profile?days=30").json()
    assert profile["counts"]["open"] == person["open_count"] == 2
    assert profile["counts"]["due_today"] == 2
    assert profile["counts"]["blocked"] == person["blocked_count"] == 0


def test_a_profile_counts_the_backlog_separately_from_todays_overdue(client, users):
    login(client, "lead@x.com")
    _task(client, title="Ancient", assignee_id=users["m1"], due_date="2020-01-01")
    _task(
        client,
        title="Slipped yesterday",
        assignee_id=users["m1"],
        due_date=(date.today() - timedelta(days=1)).isoformat(),
    )
    body = client.get(f"/api/users/{users['m1']}/profile?days=30&carry_days=7").json()
    assert body["counts"]["overdue"] == 1
    assert body["counts"]["older_overdue"] == 1
    assert [r["title"] for r in body["tasks"]["overdue"]] == ["Slipped yesterday"]


def test_the_profile_task_rows_name_the_person(client, users):
    """The complaint was that a profile existed on Tracked Time but a task only
    showed a bare name. The API must carry the picture fields on the task too."""
    login(client, "lead@x.com")
    _task(client, title="Owned", assignee_id=users["m1"], due_date=today_str())
    item = client.get("/api/tasks?scope=today").json()["items"][0]
    assert item["assignee"]["id"] == users["m1"]
    assert "display_name" in item["assignee"]
    assert "avatar_url" in item["assignee"]


def test_a_profile_carries_the_persons_own_audit_trail_only(client, users):
    login(client, "lead@x.com")
    mine = _task(client, title="Lead's own work", assignee_id=users["lead"])
    client.post(f"/api/tasks/{mine['id']}/status", headers=CSRF, json={"status": "in_progress"})

    body = client.get(f"/api/users/{users['lead']}/profile?days=7").json()
    summaries = " ".join(e["summary"] for e in body["recent_activity"])
    assert "Lead's own work" in summaries
    assert all(e["actor_id"] == users["lead"] for e in body["recent_activity"])