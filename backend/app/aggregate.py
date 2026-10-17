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

from app.config import settings
from app.models import Task, WorkSession, utcnow

# "Seconds since the epoch, right now", in each dialect's own spelling.
#
# Neither engine agrees on one, and neither does SQLAlchemy: SQLite's answer is
# a Julian day (a REAL of days since 4713 BCE), while Postgres has no numeric
# cast for `now()` at all -- `now()` is timestamptz and the stored columns are
# naive `timestamp`, so subtracting them directly is a type error. The columns
# hold naive UTC, which is what `now() AT TIME ZONE 'UTC'` produces, so the
# difference is the elapsed interval either way and `EXTRACT(EPOCH ...)` reads
# it back out in seconds.
#
# Read from `app.config`, not from `app.db`, so this module stays free of any
# dependency on the engine having been built.
_NOW = (
    literal_column("julianday('now')")
    if settings.is_sqlite
    else literal_column("(now() AT TIME ZONE 'UTC')")
)


def live_seconds(ended_at_col, started_at_col) -> case:
    """Seconds accrued by an entry that has not been paused yet, floored at zero.

    The floor is a `CASE`, not `max(a, b)`. SQLite has a two-argument scalar
    `max()`, PostgreSQL's `max()` is an aggregate that takes exactly one
    argument, so `max(0, x)` is a syntax error there -- and `greatest()` is not
    available in older SQLite either. A nested `CASE` is valid on both and
    matches the old `max(0, x)` semantics exactly, NULL included: a NULL
    comparison is not true, so a NULL elapsed value falls through to `else_`.
    """
    if settings.is_sqlite:
        elapsed = (_NOW - func.julianday(started_at_col)) * 86400
    else:
        elapsed = func.extract("epoch", _NOW - started_at_col)
    return case(
        (ended_at_col.is_(None), case((elapsed < 0, 0), else_=elapsed)),
        else_=0,
    )


LIVE_SECONDS = live_seconds(WorkSession.ended_at, WorkSession.started_at)


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
