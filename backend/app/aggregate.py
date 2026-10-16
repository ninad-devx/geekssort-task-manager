"""Shared roll-ups for time and per-task counters.

Two problems are solved here.

*Time in progress was invisible.* Every aggregate filtered on
`ended_at IS NOT NULL` and summed `duration_seconds`, which is NULL until a
timer is paused. A person with six hours on the clock was reported as having
zero. `_LIVE_SECONDS` adds what each running entry has accrued so far, so the
number on screen matches the timer in the corner.

*Four queries per task.* `task_out` ran a running-timer lookup, a log count and
a tracked-seconds sum for every single row, so a 25-row page issued roughly a
hundred queries. The `by_task` helpers below answer the same questions for a
whole page in one query each.
"""

from __future__ import annotations

from sqlalchemy import case, func, literal_column, select
from sqlalchemy.orm import Session

from app.models import Task, WorkSession, utcnow

# `julianday` is SQLite's date function and the app is SQLite-only (WAL,
# foreign_keys pragma, partial indexes written as sqlite_where). Timestamps are
# stored as naive UTC, which is what SQLite reads them as.
_now_jd = literal_column("julianday('now')")

# Seconds accrued by an entry that has not been paused yet, floored at zero.
LIVE_SECONDS = case(
    (WorkSession.ended_at.is_(None),
     func.max(0, (_now_jd - func.julianday(WorkSession.started_at)) * 86400)),
    else_=0,
)


def _not_deleted():
    return WorkSession.deleted_at.is_(None)


def live_seconds_expr():
    """Total tracked seconds: what has been closed plus what is still running."""
    return func.coalesce(func.sum(WorkSession.duration_seconds), 0) + func.coalesce(
        func.sum(LIVE_SECONDS), 0
    )


def tracked_seconds(db: Session, task_id: int) -> int:
    return int(
        db.scalar(
            select(live_seconds_expr()).where(
                WorkSession.task_id == task_id,
                _not_deleted(),
            )
        )
        or 0
    )


def tracked_seconds_by_task(db: Session, task_ids: list[int]) -> dict[int, int]:
    if not task_ids:
        return {}
    rows = db.execute(
        select(WorkSession.task_id, live_seconds_expr())
        .where(WorkSession.task_id.in_(task_ids), _not_deleted())
        .group_by(WorkSession.task_id)
    ).all()
    return {int(tid): int(seconds or 0) for tid, seconds in rows}


def log_counts_by_task(db: Session, task_ids: list[int]) -> dict[int, int]:
    if not task_ids:
        return {}
    rows = db.execute(
        select(WorkSession.task_id, func.count())
        .where(WorkSession.task_id.in_(task_ids), _not_deleted())
        .group_by(WorkSession.task_id)
    ).all()
    return {int(tid): int(n or 0) for tid, n in rows}


def running_by_task(db: Session, task_ids: list[int]) -> dict[int, list[WorkSession]]:
    """Every open timer per task, keyed by task id.

    Used to tell the viewer who else is working on a task. Only the assignee
    can start a timer, so this holds at most one entry in practice -- the shape
    is a list so the UI never has to special-case a second one.
    """
    if not task_ids:
        return {}
    rows = db.scalars(
        select(WorkSession)
        .where(
            WorkSession.task_id.in_(task_ids),
            WorkSession.ended_at.is_(None),
            _not_deleted(),
        )
        .order_by(WorkSession.started_at.asc(), WorkSession.id.asc())
    ).all()
    out: dict[int, list[WorkSession]] = {}
    for log in rows:
        out.setdefault(log.task_id, []).append(log)
    return out


def running_by_task_for_user(
    db: Session, task_ids: list[int], user_id: int
) -> dict[int, WorkSession]:
    """The caller's own open timer per task."""
    if not task_ids:
        return {}
    rows = db.scalars(
        select(WorkSession).where(
            WorkSession.task_id.in_(task_ids),
            WorkSession.user_id == user_id,
            WorkSession.ended_at.is_(None),
            _not_deleted(),
        )
    ).all()
    return {log.task_id: log for log in rows}


def tracked_seconds_in_range(
    db: Session, start, end, task_ids: list[int] | None = None
) -> int:
    conditions = [
        _not_deleted(),
        WorkSession.started_at >= start,
        WorkSession.started_at <= end,
    ]
    if task_ids is not None:
        conditions.append(WorkSession.task_id.in_(task_ids))
    return int(db.scalar(select(live_seconds_expr()).where(*conditions)) or 0)


def tracked_seconds_by_assignee(db: Session, start, end) -> dict[int, int]:
    """Tracked seconds per assignee over a window, in one query.

    Used by the dashboards, which previously ran the same sum once per person
    on the team.
    """
    rows = db.execute(
        select(Task.assignee_id, live_seconds_expr())
        .join(WorkSession, WorkSession.task_id == Task.id)
        .where(
            Task.deleted_at.is_(None),
            Task.assignee_id.is_not(None),
            _not_deleted(),
            WorkSession.started_at >= start,
            WorkSession.started_at <= end,
        )
        .group_by(Task.assignee_id)
    ).all()
    return {int(uid): int(seconds or 0) for uid, seconds in rows if uid is not None}


def running_elapsed(db: Session, log, now=None) -> int:
    now = now or utcnow()
    end = log.ended_at or now
    return max(0, int((end - log.started_at).total_seconds()))