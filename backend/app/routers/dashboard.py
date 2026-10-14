from __future__ import annotations

from datetime import date, datetime, time, timedelta

from fastapi import APIRouter, Depends, Query
from sqlalchemy import Select, func, select
from sqlalchemy.orm import Session

from app import policy
from app.config import settings
from app.db import get_db
from app.deps import CurrentUser, get_current_user
from app.errors import forbidden
from app.models import Task, TaskStatus, User, WorkSession, utcnow
from app.serializers import local_today, running_session_for_user
from app.timelog import to_utc

router = APIRouter(prefix="/dashboard", tags=["dashboard"])

OPEN_STATUSES = (
    TaskStatus.todo.value,
    TaskStatus.in_progress.value,
    TaskStatus.blocked.value,
    TaskStatus.in_review.value,
)


def _range(days: int) -> tuple[datetime, datetime]:
    """Last N days including today, in APP_TIMEZONE, converted to UTC bounds."""
    today = local_today()
    start_date = today - timedelta(days=days - 1)
    tz = settings.tz
    start_local = datetime.combine(start_date, time.min, tzinfo=tz)
    end_local = datetime.combine(today, time.max, tzinfo=tz)
    return start_local.astimezone(tz).replace(tzinfo=None), end_local.astimezone(tz).replace(tzinfo=None)


def _period(period: str) -> tuple[datetime, datetime]:
    """A named window: today, week, month, or the trailing N days.

    `today` is what people reach for first — "what happened today" is a
    different question from "what happened in the last seven days".
    """
    if period == "today":
        today = local_today()
        tz = settings.tz
        start = datetime.combine(today, time.min, tzinfo=tz)
        end = datetime.combine(today, time.max, tzinfo=tz)
        return start.astimezone(tz).replace(tzinfo=None), end.astimezone(tz).replace(tzinfo=None)
    if period == "week":
        return _range(7)
    if period == "month":
        return _range(30)
    if period == "quarter":
        return _range(90)
    return _range(7)


def _period_label(period: str, days: int) -> str:
    if period == "today":
        return "today"
    if period == "month":
        return "the last 30 days"
    if period == "quarter":
        return "the last 90 days"
    return f"the last {days} days"


def _visible_tasks(current: CurrentUser) -> Select:
    stmt = select(Task).where(Task.deleted_at.is_(None))
    if not policy.can_view_all_tasks(current.user):
        stmt = stmt.where(
            Task.assignee_id == current.user.id,
        )
    return stmt


def _alias(stmt: Select):
    """Alias a filtered task query so its columns can be counted without re-joining `tasks`.

    Referencing bare `Task.*` alongside a subquery of the same table would fan out rows.
    """
    return stmt.subquery().alias("t")


def _status_counts(db: Session, stmt: Select) -> dict[str, int]:
    sub = _alias(stmt)
    rows = db.execute(
        select(sub.c.status, func.count()).select_from(sub).group_by(sub.c.status)
    ).all()
    return {r[0]: int(r[1]) for r in rows}


def _tracked(db: Session, task_stmt: Select, start: datetime, end: datetime) -> int:
    sub = _alias(task_stmt)
    total = db.scalar(
        select(func.coalesce(func.sum(WorkSession.duration_seconds), 0)).where(
            WorkSession.task_id.in_(select(sub.c.id)),
            WorkSession.deleted_at.is_(None),
            WorkSession.ended_at.is_not(None),
            WorkSession.started_at >= start,
            WorkSession.started_at <= end,
        )
    )
    return int(total or 0)


def _working_now(db: Session, current: CurrentUser) -> list[dict]:
    stmt = select(WorkSession).where(WorkSession.ended_at.is_(None), WorkSession.deleted_at.is_(None))
    if not policy.can_view_all_tasks(current.user):
        stmt = stmt.where(WorkSession.user_id == current.user.id)
    rows = db.scalars(stmt).all()
    now = utcnow()
    out = []
    for log in rows:
        task = db.get(Task, log.task_id)
        if task is None or task.deleted_at is not None:
            continue
        out.append(
            {
                "log_id": log.id,
                "user": {"id": log.user_id, "full_name": log.user.full_name if log.user else "Unknown"},
                "task": {"id": task.id, "title": task.title},
                "started_at": log.started_at,
                "elapsed_seconds": max(0, int((now - log.started_at).total_seconds())),
                "is_stale": max(0, int((now - log.started_at).total_seconds()))
                > settings.MAX_TIMER_HOURS * 3600,
            }
        )
    out.sort(key=lambda r: r["started_at"])
    return out


def _member_load(db: Session, task_stmt: Select, start: datetime, end: datetime) -> list[dict]:
    open_stmt = task_stmt.where(Task.status != TaskStatus.completed.value)
    sub = _alias(open_stmt)
    rows = db.execute(
        select(User.id, User.full_name, User.role, func.count(sub.c.id))
        .select_from(sub.join(User, User.id == sub.c.assignee_id))
        .where(sub.c.deleted_at.is_(None))
        .group_by(User.id, User.full_name, User.role)
        .order_by(User.full_name)
    ).all()
    out = []
    for uid, full_name, role, open_count in rows:
        seconds = _tracked(
            db,
            select(Task.id).where(Task.assignee_id == uid, Task.deleted_at.is_(None)),
            start,
            end,
        )
        out.append(
            {
                "user": {"id": uid, "full_name": full_name, "role": role},
                "open_tasks": int(open_count),
                "tracked_seconds": seconds,
            }
        )
    return out


def _base_payload(db: Session, current: CurrentUser, stmt: Select, start: datetime, end: datetime) -> dict:
    counts = _status_counts(db, stmt)
    sub = _alias(stmt)
    today = local_today()
    overdue = int(
        db.scalar(
            select(func.count()).select_from(sub).where(
                sub.c.due_date.is_not(None),
                sub.c.due_date < today,
                sub.c.status != TaskStatus.completed.value,
                sub.c.deleted_at.is_(None),
            )
        )
        or 0
    )
    due_today = int(
        db.scalar(
            select(func.count()).select_from(sub).where(
                sub.c.due_date == today,
                sub.c.status != TaskStatus.completed.value,
                sub.c.deleted_at.is_(None),
            )
        )
        or 0
    )
    completed = int(
        db.scalar(
            select(func.count()).select_from(sub).where(
                sub.c.completed_at >= start, sub.c.completed_at <= end
            )
        )
        or 0
    )
    return {
        "server_time": utcnow(),
        "app_timezone": settings.APP_TIMEZONE,
        "range": {"from": start, "to": end},
        "counts": {
            "total": sum(counts.values()),
            "by_status": {s.value: counts.get(s.value, 0) for s in TaskStatus},
            "open": sum(counts.get(s, 0) for s in OPEN_STATUSES),
            "overdue": overdue,
            "due_today": due_today,
            "completed_in_range": completed,
            "in_progress": counts.get(TaskStatus.in_progress.value, 0),
            "blocked": counts.get(TaskStatus.blocked.value, 0),
            "tracked_seconds": _tracked(db, stmt, start, end),
        },
        "working_now": _working_now(db, current),
    }


@router.get("/executive")
def executive(
    current: CurrentUser = Depends(get_current_user),
    db: Session = Depends(get_db),
    days: int = Query(default=7, ge=1, le=90),
    period: str = Query(default="week"),
):
    if not policy.capabilities(current.user)["can_view_executive_dashboard"]:
        raise forbidden("FORBIDDEN", "The executive dashboard is for the CEO and team lead")
    start, end = _period(period)
    stmt = _visible_tasks(current)
    payload = _base_payload(db, current, stmt, start, end)
    payload["period"] = period
    payload["period_label"] = _period_label(period, days)
    payload["members"] = _member_load(db, stmt, start, end)
    return payload


@router.get("/lead")
def lead(
    current: CurrentUser = Depends(get_current_user),
    db: Session = Depends(get_db),
    days: int = Query(default=7, ge=1, le=90),
    period: str = Query(default="week"),
    assignee_id: int | None = Query(default=None),
    category: str | None = Query(default=None),
):
    if not policy.capabilities(current.user)["can_view_lead_dashboard"]:
        raise forbidden("FORBIDDEN", "The team lead dashboard is for the CEO and team lead")
    start, end = _period(period)
    stmt = _visible_tasks(current)
    if assignee_id is not None:
        stmt = stmt.where(Task.assignee_id == assignee_id)
    if category:
        stmt = stmt.where(Task.category == category)
    payload = _base_payload(db, current, stmt, start, end)
    payload["period"] = period
    payload["period_label"] = _period_label(period, days)
    payload["members"] = _member_load(db, stmt, start, end)

    sub = _alias(stmt)
    in_review = int(
        db.scalar(
            select(func.count()).select_from(sub).where(
                sub.c.status == TaskStatus.in_review.value, sub.c.deleted_at.is_(None)
            )
        )
        or 0
    )
    blocked_today = db.execute(
        select(sub.c.id, sub.c.title, sub.c.blocked_reason, User.full_name)
        .select_from(sub.outerjoin(User, User.id == sub.c.assignee_id))
        .where(sub.c.status == TaskStatus.blocked.value, sub.c.deleted_at.is_(None))
        .order_by(sub.c.updated_at.desc())
        .limit(10)
    ).all()
    payload["needs_attention"] = {
        "in_review": in_review,
        "blocked": [
            {"id": r[0], "title": r[1], "blocked_reason": r[2], "assignee": r[3]}
            for r in blocked_today
        ],
    }
    return payload


@router.get("/personal")
def personal(
    current: CurrentUser = Depends(get_current_user),
    db: Session = Depends(get_db),
    days: int = Query(default=7, ge=1, le=90),
    period: str = Query(default="week"),
):
    start, end = _period(period)
    stmt = select(Task).where(Task.deleted_at.is_(None), Task.assignee_id == current.user.id)
    payload = _base_payload(db, current, stmt, start, end)

    daily = db.execute(
        select(
            func.date(WorkSession.started_at).label("day"),
            func.coalesce(func.sum(WorkSession.duration_seconds), 0),
        )
        .where(
            WorkSession.user_id == current.user.id,
            WorkSession.deleted_at.is_(None),
            WorkSession.ended_at.is_not(None),
            WorkSession.started_at >= start,
            WorkSession.started_at <= end,
        )
        .group_by("day")
        .order_by("day")
    ).all()
    payload["daily"] = [{"day": str(r[0]), "seconds": int(r[1])} for r in daily]

    today = local_today()
    sub = _alias(stmt)

    def _count(*conditions) -> int:
        return int(db.scalar(select(func.count()).select_from(sub).where(*conditions)) or 0)

    payload["attention"] = {
        "due_today": _count(sub.c.due_date == today, sub.c.status != TaskStatus.completed.value),
        "overdue": _count(
            sub.c.due_date.is_not(None),
            sub.c.due_date < today,
            sub.c.status != TaskStatus.completed.value,
        ),
        "blocked": _count(sub.c.status == TaskStatus.blocked.value),
        "in_review": _count(sub.c.status == TaskStatus.in_review.value),
    }

    # Carry-forward: work that was already open before today and is still not
    # done. These tasks never leave the database, but without this list they are
    # invisible the moment the day rolls over, which is exactly the work someone
    # forgot they had.
    carried = db.execute(
        select(sub.c.id, sub.c.title, sub.c.status, sub.c.due_date, sub.c.created_at)
        .select_from(sub)
        .where(
            sub.c.status.in_(
                (TaskStatus.todo.value, TaskStatus.in_progress.value, TaskStatus.blocked.value)
            ),
            sub.c.created_at < datetime.combine(today, time.min),
        )
        .order_by(sub.c.due_date.is_(None), sub.c.due_date.asc(), sub.c.created_at.asc())
        .limit(25)
    ).all()
    payload["carried_over"] = [
        {
            "id": r[0],
            "title": r[1],
            "status": r[2],
            "due_date": str(r[3]) if r[3] else None,
            "is_overdue": bool(r[3]) and r[3] < today,
        }
        for r in carried
    ]

    running = running_session_for_user(db, current.user.id)
    payload["worklists"] = _worklists(db, stmt, today)
    payload["period"] = period
    payload["period_label"] = _period_label(period, days)
    if running is not None:
        payload["running"] = {
            "log_id": running.id,
            "task_id": running.task_id,
            "task_title": (db.get(Task, running.task_id).title if db.get(Task, running.task_id) else "Task"),
            "started_at": running.started_at,
            "elapsed_seconds": 0,
            "is_stale": False,
        }
    return payload


def _worklists(db: Session, stmt: Select, today) -> dict:
    """The four lists the dashboard shows as sections: what is moving, what is
    done, and what is slipping. Cards carry the numbers; these carry the work."""
    sub = _alias(stmt)
    base = (sub.c.deleted_at.is_(None),)

    def rows(*conditions):
        result = db.execute(
            select(
                sub.c.id,
                sub.c.title,
                sub.c.status,
                sub.c.due_date,
                User.id,
                User.full_name,
                User.display_name,
                User.avatar_url,
                User.avatar_color,
                User.role,
            )
            .select_from(sub.outerjoin(User, User.id == sub.c.assignee_id))
            .where(*base, *conditions)
            .order_by(sub.c.due_date.is_(None), sub.c.due_date.asc(), sub.c.id.asc())
            .limit(25)
        ).all()
        return [
            {
                "id": r[0],
                "title": r[1],
                "status": r[2],
                "due_date": str(r[3]) if r[3] else None,
                "is_overdue": bool(r[3]) and r[3] < today,
                "assignee": (
                    {
                        "id": r[4],
                        "full_name": r[5],
                        "display_name": r[6],
                        "avatar_url": r[7],
                        "avatar_color": r[8],
                        "role": r[9],
                    }
                    if r[4] is not None
                    else None
                ),
            }
            for r in result
        ]

    return {
        "in_progress": rows(sub.c.status == TaskStatus.in_progress.value),
        "completed": rows(
            sub.c.status == TaskStatus.completed.value,
            sub.c.completed_at.is_not(None),
        ),
        "overdue": rows(
            sub.c.due_date.is_not(None),
            sub.c.due_date < today,
            sub.c.status != TaskStatus.completed.value,
        ),
        "blocked": rows(
            sub.c.status == TaskStatus.blocked.value,
            sub.c.blocked_reason.is_not(None),
        ),
    }
    payload["running"] = None
    if running is not None:
        task = db.get(Task, running.task_id)
        from app.serializers import elapsed, is_stale

        payload["running"] = {
            "log_id": running.id,
            "task_id": running.task_id,
            "task_title": task.title if task else "Task",
            "started_at": running.started_at,
            "elapsed_seconds": elapsed(running),
            "is_stale": is_stale(running),
        }
    return payload


@router.get("/time-summary")
def time_summary(
    current: CurrentUser = Depends(get_current_user),
    db: Session = Depends(get_db),
    days: int = Query(default=7, ge=1, le=90),
    user_id: int | None = Query(default=None),
):
    if not policy.can_view_all_tasks(current.user) and user_id not in (None, current.user.id):
        raise forbidden("FORBIDDEN", "You may only view your own time summary")
    start, end = _range(days)
    target = user_id or current.user.id
    stmt = select(WorkSession).where(
        WorkSession.user_id == target,
        WorkSession.deleted_at.is_(None),
        WorkSession.ended_at.is_not(None),
        WorkSession.started_at >= start,
        WorkSession.started_at <= end,
    )
    sub = stmt.subquery().alias("s")
    rows = db.execute(
        select(sub.c.task_id, Task.title, func.coalesce(func.sum(sub.c.duration_seconds), 0))
        .select_from(sub.join(Task, Task.id == sub.c.task_id))
        .where(Task.deleted_at.is_(None))
        .group_by(sub.c.task_id, Task.title)
        .order_by(func.sum(sub.c.duration_seconds).desc())
    ).all()
    total = sum(int(r[2]) for r in rows)
    return {
        "server_time": utcnow(),
        "range": {"from": start, "to": end},
        "total_seconds": total,
        "by_task": [
            {"task_id": r[0], "title": r[1], "seconds": int(r[2])} for r in rows
        ],
    }