from __future__ import annotations

from fastapi import APIRouter, Depends, Query
from sqlalchemy import func, or_, select
from sqlalchemy.orm import Session

from app import policy, timelog
from app.db import get_db, write_tx
from app.deps import CurrentUser, get_current_user
from app.errors import forbidden, not_found
from app.models import EntryType, Source, Task, TaskStatus, WorkSession, utcnow
from app.schemas import (
    LogEditIn,
    LogOut,
    ManualEntryIn,
    PauseIn,
    PauseOut,
    StartOut,
    TimePersonTotal,
    TimeSummaryOut,
    TimeTaskTotal,
)
from app.serializers import log_out, task_out

router = APIRouter(tags=["task-logs"])


def _visible_task(current: CurrentUser, db: Session, task_id: int) -> Task:
    task = db.get(Task, task_id)
    if task is None or not policy.can_see_task(current.user, task):
        raise not_found("TASK_NOT_FOUND", "Task not found")
    return task


def _load_log(current: CurrentUser, db: Session, log_id: int) -> WorkSession:
    log = db.get(WorkSession, log_id)
    if log is None:
        raise not_found("LOG_NOT_FOUND", "Time entry not found")
    task = db.get(Task, log.task_id)
    if task is None or not policy.can_see_task(current.user, task):
        raise not_found("LOG_NOT_FOUND", "Time entry not found")
    if log.deleted_at is not None and not policy.can_view_all_tasks(current.user):
        raise not_found("LOG_NOT_FOUND", "Time entry not found")
    return log


# --- timer -----------------------------------------------------------------

@router.post("/tasks/{task_id}/timer/start", response_model=StartOut)
def start_timer(task_id: int, current: CurrentUser = Depends(get_current_user)):
    with write_tx() as db:
        task = _load_task_for_timer(current, db, task_id)
        result = timelog.start(db, task, current.user)
        db.flush()
        db.refresh(task)
        return StartOut(
            log=log_out(current.user, result["log"], db),
            task=task_out(current.user, task, db),
            paused_previous=(
                log_out(current.user, result["paused_previous"], db)
                if result["paused_previous"] is not None
                else None
            ),
        )


def _load_task_for_timer(current: CurrentUser, db: Session, task_id: int) -> Task:
    task = db.get(Task, task_id)
    if task is None or not policy.can_see_task(current.user, task):
        raise not_found("TASK_NOT_FOUND", "Task not found")
    if task.deleted_at is not None:
        raise not_found("TASK_NOT_FOUND", "Task not found")
    return task


@router.post("/timer/pause", response_model=PauseOut)
def pause_timer(payload: PauseIn, current: CurrentUser = Depends(get_current_user)):
    with write_tx() as db:
        result = timelog.pause(
            db,
            current.user,
            log_id=payload.log_id,
            ended_at=payload.ended_at,
            note=payload.note,
            progress_percent=payload.progress_percent,
            evidence_url=payload.evidence_url,
        )
        log = result["log"]
        task = db.get(Task, log.task_id)
        db.flush()
        db.refresh(task)
        return PauseOut(
            log=log_out(current.user, log, db),
            task=task_out(current.user, task, db),
            adjusted=result["adjusted"],
        )


@router.get("/timer/current")
def current_timer(current: CurrentUser = Depends(get_current_user), db: Session = Depends(get_db)):
    from app.serializers import elapsed, is_stale, running_sessions_for_user

    rows = running_sessions_for_user(db, current.user.id)
    if not rows:
        return {"running": [], "server_time": utcnow()}
    return {
        "running": [
            {
                "log_id": log.id,
                "task_id": log.task_id,
                "task_title": (db.get(Task, log.task_id).title if db.get(Task, log.task_id) else "Task"),
                "started_at": log.started_at,
                "elapsed_seconds": elapsed(log),
                "is_stale": is_stale(log),
            }
            for log in rows
        ],
        "server_time": utcnow(),
    }


# --- time reporting ---------------------------------------------------------

@router.get("/time/summary", response_model=TimeSummaryOut)
def time_summary(
    current: CurrentUser = Depends(get_current_user),
    db: Session = Depends(get_db),
    days: int = Query(default=30, ge=1, le=365),
    user_id: int | None = Query(default=None),
):
    """Tracked time rolled up per person and per task.

    An employee sees only their own hours. A CEO or team lead sees everyone's,
    which is what makes the company figure drillable: company -> person -> task.
    Raw per-timer rows stay on the task page; this is the summary people
    actually read.
    """
    from datetime import timedelta

    from app.models import User
    from app.serializers import actor_out

    end = utcnow()
    start = (end - timedelta(days=days)).replace(hour=0, minute=0, second=0, microsecond=0)

    sees_everyone = policy.can_view_all_tasks(current.user)

    conditions = [
        WorkSession.deleted_at.is_(None),
        WorkSession.started_at >= start,
        WorkSession.started_at <= end,
        WorkSession.entry_type == EntryType.work_session.value,
    ]
    if not sees_everyone:
        conditions.append(WorkSession.user_id == current.user.id)
    elif user_id is not None:
        conditions.append(WorkSession.user_id == user_id)

    scope = policy.task_query_scope(current.user)
    if scope is not None:
        conditions.append(scope)

    rows = db.execute(
        select(
            WorkSession.user_id,
            WorkSession.task_id,
            func.coalesce(func.sum(WorkSession.duration_seconds), 0),
            func.count(),
        )
        .join(Task, Task.id == WorkSession.task_id)
        .where(*conditions)
        .group_by(WorkSession.user_id, WorkSession.task_id)
    ).all()

    by_person: dict[int, dict[int, tuple[int, int]]] = {}
    for uid, tid, seconds, count in rows:
        by_person.setdefault(uid, {})[tid] = (int(seconds or 0), int(count or 0))

    people: list[TimePersonTotal] = []
    for uid, tasks in sorted(by_person.items(), key=lambda kv: -sum(v[0] for v in kv[1].values())):
        user = db.get(User, uid)
        if user is None:
            continue
        task_totals: list[TimeTaskTotal] = []
        for tid, (seconds, count) in sorted(
            tasks.items(), key=lambda kv: -kv[1][0]
        ):
            task = db.get(Task, tid)
            if task is None:
                continue
            task_totals.append(
                TimeTaskTotal(
                    task_id=task.id,
                    task_title=task.title,
                    task_status=task.status,
                    seconds=seconds,
                    entry_count=count,
                )
            )
        people.append(
            TimePersonTotal(
                user=actor_out(user),
                seconds=sum(t.seconds for t in task_totals),
                entry_count=sum(t.entry_count for t in task_totals),
                tasks=task_totals,
            )
        )

    return TimeSummaryOut(
        scope="company" if sees_everyone else "self",
        days=days,
        total_seconds=sum(p.seconds for p in people),
        people=people,
    )


# --- manual entries and notes ----------------------------------------------

@router.post("/tasks/{task_id}/logs", response_model=LogOut, status_code=201)
def add_log(task_id: int, payload: ManualEntryIn, current: CurrentUser = Depends(get_current_user)):
    with write_tx() as db:
        task = _load_task_for_timer(current, db, task_id)
        log = timelog.add_manual(db, task, current.user, payload)
        db.flush()
        return log_out(current.user, log, db)


@router.get("/tasks/{task_id}/logs", response_model=list[LogOut])
def list_logs(
    task_id: int,
    current: CurrentUser = Depends(get_current_user),
    db: Session = Depends(get_db),
    include_deleted: bool = Query(default=False),
):
    task = _load_task_for_timer(current, db, task_id)
    stmt = select(WorkSession).where(WorkSession.task_id == task.id)
    if not include_deleted or not policy.can_view_all_tasks(current.user):
        stmt = stmt.where(WorkSession.deleted_at.is_(None))
    rows = db.scalars(stmt.order_by(WorkSession.started_at.asc(), WorkSession.id.asc())).all()
    return [log_out(current.user, r, db) for r in rows]


@router.patch("/logs/{log_id}", response_model=LogOut)
def edit_log(log_id: int, payload: LogEditIn, current: CurrentUser = Depends(get_current_user)):
    with write_tx() as db:
        log = _load_log(current, db, log_id)
        if log.entry_type == EntryType.note.value:
            payload = LogEditIn(**{**payload.model_dump(), "ended_at": None, "if_ended_at_unchanged": True})
        updated = timelog.edit(db, log, current.user, payload)
        db.flush()
        return log_out(current.user, updated, db)


@router.delete("/logs/{log_id}", response_model=LogOut)
def delete_log(log_id: int, current: CurrentUser = Depends(get_current_user)):
    with write_tx() as db:
        log = _load_log(current, db, log_id)
        deleted = timelog.delete(db, log, current.user)
        db.flush()
        return log_out(current.user, deleted, db)