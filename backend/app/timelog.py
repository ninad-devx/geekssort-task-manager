"""Time-log operations. Every function runs inside one write transaction and reads
`now` once from the server clock (SRS 10.3, D-06, D-15)."""

from __future__ import annotations

from datetime import datetime, timedelta

from sqlalchemy import select
from sqlalchemy.orm import Session

from app import audit, policy
from app.config import settings
from app.errors import conflict, forbidden, unprocessable
from app.models import (
    EntryType,
    EventType,
    Role,
    Source,
    Task,
    TaskStatus,
    User,
    WorkSession,
    utcnow,
)
from app.security import validate_evidence_url


def as_naive_utc(value: datetime) -> datetime:
    if value.tzinfo is not None:
        return value.astimezone(tz=None).replace(tzinfo=None)
    return value


def to_utc(value: datetime) -> datetime:
    from datetime import timezone

    if value.tzinfo is None:
        return value.replace(tzinfo=timezone.utc).astimezone(timezone.utc).replace(tzinfo=None)
    return value.astimezone(timezone.utc).replace(tzinfo=None)


def snapshot(log: WorkSession) -> dict:
    return {
        "id": log.id,
        "task_id": log.task_id,
        "user_id": log.user_id,
        "entry_type": log.entry_type,
        "source": log.source,
        "started_at": log.started_at,
        "ended_at": log.ended_at,
        "duration_seconds": log.duration_seconds,
        "note": log.note,
        "progress_percent": log.progress_percent,
        "evidence_url": log.evidence_url,
        "edit_count": log.edit_count,
    }


# --- validation ------------------------------------------------------------

def validate_interval(
    db: Session,
    user: User,
    started_at: datetime,
    ended_at: datetime | None,
    *,
    now: datetime,
    exclude_log_id: int | None = None,
    is_running: bool = False,
) -> None:
    if is_running or ended_at is None:
        return

    if ended_at <= started_at:
        raise unprocessable("INVALID_INTERVAL", "ended_at must be after started_at")

    skew = now + timedelta(minutes=settings.CLOCK_SKEW_ALLOWANCE_MINUTES)
    if ended_at > skew:
        raise unprocessable("END_IN_FUTURE", "ended_at cannot be in the future")

    duration = int((ended_at - started_at).total_seconds())
    if duration > settings.MAX_SESSION_HOURS * 3600:
        raise unprocessable(
            "DURATION_TOO_LONG",
            f"A single entry cannot exceed {settings.MAX_SESSION_HOURS} hours",
        )

    window_start, window_end = started_at, ended_at
    candidates = db.scalars(
        select(WorkSession).where(
            WorkSession.user_id == user.id,
            WorkSession.deleted_at.is_(None),
            WorkSession.entry_type == EntryType.work_session.value,
        )
    ).all()
    for other in candidates:
        if exclude_log_id is not None and other.id == exclude_log_id:
            continue
        o_start = other.started_at
        o_end = other.ended_at or now  # a running entry counts as ending now
        if o_end <= window_start or o_start >= window_end:
            continue
        raise conflict(
            "TIME_OVERLAP",
            "This entry overlaps another session",
            conflicting_log_id=other.id,
        )


def check_edit_window(log: WorkSession, now: datetime) -> None:
    if settings.TIME_EDIT_WINDOW_DAYS <= 0:
        return
    anchor = log.started_at if log.ended_at is None else log.ended_at
    if now - anchor > timedelta(days=settings.TIME_EDIT_WINDOW_DAYS):
        raise forbidden("EDIT_WINDOW_EXPIRED", "This entry is outside the edit window")


def check_can_edit_time(user: User) -> None:
    if not settings.MEMBER_CAN_EDIT_TIME:
        raise forbidden("TIME_EDIT_DISABLED", "Editing your own time entries is disabled")


# --- auto close ------------------------------------------------------------

def close_running_for_task(
    db: Session,
    task: Task,
    now: datetime,
    actor: User | None,
    reason: str,
) -> WorkSession | None:
    log = db.scalar(
        select(WorkSession).where(
            WorkSession.task_id == task.id,
            WorkSession.ended_at.is_(None),
            WorkSession.deleted_at.is_(None),
        )
    )
    if log is None:
        return None
    log.ended_at = now
    log.duration_seconds = max(0, int((now - log.started_at).total_seconds()))
    db.flush()
    audit.record(
        db,
        event_type=EventType.timer_paused.value,
        entity_type="task_log",
        entity_id=log.id,
        task_id=task.id,
        actor=actor if actor else log.user,
        summary=f"Timer on “{task.title}” closed automatically ({reason})",
        before={"ended_at": None},
        after={"ended_at": now, "duration_seconds": log.duration_seconds},
        meta={"auto": True, "reason": reason},
        created_at=now,
    )
    return log


def close_running_for_user(db: Session, user_id: int, now: datetime, reason: str) -> None:
    log = db.scalar(
        select(WorkSession).where(
            WorkSession.user_id == user_id,
            WorkSession.ended_at.is_(None),
            WorkSession.deleted_at.is_(None),
        )
    )
    if log is None:
        return
    task = db.get(Task, log.task_id)
    log.ended_at = now
    log.duration_seconds = max(0, int((now - log.started_at).total_seconds()))
    db.flush()
    audit.record(
        db,
        event_type=EventType.timer_paused.value,
        entity_type="task_log",
        entity_id=log.id,
        task_id=log.task_id,
        actor=task.assignee if task else None,
        summary=f"Timer closed automatically ({reason})",
        before={"ended_at": None},
        after={"ended_at": now, "duration_seconds": log.duration_seconds},
        meta={"auto": True, "reason": reason},
        created_at=now,
    )


# --- operations ------------------------------------------------------------

def start(db: Session, task: Task, user: User, now: datetime | None = None) -> dict:
    now = now or utcnow()

    if not policy.can_track_time(user, task):
        raise forbidden("NOT_ASSIGNEE", "You can only track time on tasks assigned to you")
    if task.status == TaskStatus.completed.value:
        raise conflict("TASK_COMPLETED", "A completed task cannot be tracked")

    paused_previous = None
    existing = db.scalar(
        select(WorkSession).where(
            WorkSession.user_id == user.id,
            WorkSession.ended_at.is_(None),
            WorkSession.deleted_at.is_(None),
        )
    )
    if existing is not None:
        if existing.task_id == task.id:
            raise conflict("TIMER_ALREADY_RUNNING", "This timer is already running")
        paused_previous = existing
        previous_task = db.get(Task, existing.task_id)
        existing.ended_at = now
        existing.duration_seconds = max(0, int((now - existing.started_at).total_seconds()))
        db.flush()
        audit.record(
            db,
            event_type=EventType.timer_paused.value,
            entity_type="task_log",
            entity_id=existing.id,
            task_id=existing.task_id,
            actor=user,
            summary=f"Timer on “{previous_task.title if previous_task else 'a task'}” paused because another timer started",
            before={"ended_at": None},
            after={"ended_at": now, "duration_seconds": existing.duration_seconds},
            meta={"reason": "switched_task"},
            created_at=now,
        )

    log = WorkSession(
        task_id=task.id,
        user_id=user.id,
        entry_type=EntryType.work_session.value,
        source=Source.timer.value,
        started_at=now,
        created_at=now,
    )
    db.add(log)
    db.flush()

    audit.record(
        db,
        event_type=EventType.timer_started.value,
        entity_type="task_log",
        entity_id=log.id,
        task_id=task.id,
        actor=user,
        summary=f"Timer started on “{task.title}”",
        after={"started_at": now, "source": Source.timer.value},
        created_at=now,
    )

    # FR-TIME-002: one status event, never two
    if task.status in (TaskStatus.todo.value, TaskStatus.blocked.value, TaskStatus.in_review.value):
        previous = task.status
        task.status = TaskStatus.in_progress.value
        if previous == TaskStatus.blocked.value:
            task.blocked_reason = None
        task.version += 1
        task.updated_at = now
        audit.record(
            db,
            event_type=EventType.task_status_changed.value,
            entity_type="task",
            entity_id=task.id,
            task_id=task.id,
            actor=user,
            summary=f"“{task.title}” moved to In Progress (timer started)",
            before={"status": previous},
            after={"status": task.status},
            created_at=now,
        )

    return {"log": log, "paused_previous": paused_previous}


def pause(
    db: Session,
    user: User,
    *,
    ended_at: datetime | None = None,
    note: str | None = None,
    progress_percent: int | None = None,
    evidence_url: str | None = None,
    now: datetime | None = None,
) -> dict:
    now = now or utcnow()
    log = db.scalar(
        select(WorkSession).where(
            WorkSession.user_id == user.id,
            WorkSession.ended_at.is_(None),
            WorkSession.deleted_at.is_(None),
        )
    )
    if log is None:
        raise conflict("NO_RUNNING_TIMER", "You have no running timer")

    adjusted = False
    if ended_at is None:
        effective_end = now
    else:
        effective_end = to_utc(ended_at)
        if abs((now - effective_end).total_seconds()) > 60:
            adjusted = True
        if effective_end > now:
            effective_end = now
    effective_end = min(effective_end, now)

    if effective_end <= log.started_at:
        raise unprocessable("INVALID_INTERVAL", "End time must be after the start time")
    if int((effective_end - log.started_at).total_seconds()) > settings.MAX_SESSION_HOURS * 3600:
        raise unprocessable("DURATION_TOO_LONG", "This session is longer than the maximum")

    task = db.get(Task, log.task_id)
    before = {"ended_at": None, "duration_seconds": None}
    log.ended_at = effective_end
    log.duration_seconds = int((effective_end - log.started_at).total_seconds())
    if note is not None:
        log.note = note
    if progress_percent is not None:
        log.progress_percent = progress_percent
        if task is not None:
            task.progress_percent = progress_percent
    if evidence_url is not None:
        err = validate_evidence_url(evidence_url)
        if err:
            raise unprocessable("UNSAFE_URL", err)
        log.evidence_url = evidence_url
    db.flush()

    audit.record(
        db,
        event_type=EventType.timer_paused.value,
        entity_type="task_log",
        entity_id=log.id,
        task_id=log.task_id,
        actor=user,
        summary=(
            f"Timer paused on “{task.title if task else 'a task'}”"
            + (" with an adjusted end time" if adjusted else "")
        ),
        before=before,
        after={
            "ended_at": log.ended_at,
            "duration_seconds": log.duration_seconds,
            "note": log.note,
        },
        meta={"adjusted": adjusted},
        created_at=now,
    )
    return {"log": log, "adjusted": adjusted}


def add_manual(db: Session, task: Task, user: User, payload, now: datetime | None = None) -> WorkSession:
    now = now or utcnow()
    if not policy.can_track_time(user, task):
        raise forbidden("NOT_ASSIGNEE", "You can only record time on tasks assigned to you")

    started_at = to_utc(payload.started_at)
    if payload.entry_type == EntryType.note.value:
        if not payload.note or not payload.note.strip():
            raise unprocessable("NOTE_REQUIRED", "A note needs 1-2000 characters")
        err = validate_evidence_url(payload.evidence_url)
        if err:
            raise unprocessable("UNSAFE_URL", err)
        log = WorkSession(
            task_id=task.id,
            user_id=user.id,
            entry_type=EntryType.note.value,
            source=Source.manual.value,
            started_at=started_at,
            ended_at=started_at,
            duration_seconds=0,
            note=payload.note,
            progress_percent=payload.progress_percent,
            evidence_url=payload.evidence_url,
            created_at=now,
        )
        db.add(log)
        db.flush()
        audit.record(
            db,
            event_type=EventType.log_note_added.value,
            entity_type="task_log",
            entity_id=log.id,
            task_id=task.id,
            actor=user,
            summary=f"Note added on “{task.title}”",
            after={"note": payload.note, "progress_percent": payload.progress_percent},
            created_at=now,
        )
        return log

    ended_at = to_utc(payload.ended_at) if payload.ended_at else None
    if ended_at is None and payload.duration_minutes is not None:
        ended_at = started_at + timedelta(minutes=payload.duration_minutes)
    if ended_at is None:
        raise unprocessable("ENDED_AT_REQUIRED", "Provide ended_at or duration_minutes")
    ended_at = min(ended_at, now)

    err = validate_evidence_url(payload.evidence_url)
    if err:
        raise unprocessable("UNSAFE_URL", err)

    validate_interval(db, user, started_at, ended_at, now=now)
    if started_at > now:
        raise unprocessable("START_IN_FUTURE", "started_at cannot be in the future")

    log = WorkSession(
        task_id=task.id,
        user_id=user.id,
        entry_type=EntryType.work_session.value,
        source=Source.manual.value,
        started_at=started_at,
        ended_at=ended_at,
        duration_seconds=int((ended_at - started_at).total_seconds()),
        note=payload.note,
        progress_percent=payload.progress_percent,
        evidence_url=payload.evidence_url,
        created_at=now,
    )
    db.add(log)
    db.flush()

    if payload.progress_percent is not None:
        task.progress_percent = payload.progress_percent

    audit.record(
        db,
        event_type=EventType.log_manual_added.value,
        entity_type="task_log",
        entity_id=log.id,
        task_id=task.id,
        actor=user,
        summary=f"Time added manually to “{task.title}”",
        after={
            "started_at": started_at,
            "ended_at": ended_at,
            "duration_seconds": log.duration_seconds,
            "note": payload.note,
        },
        created_at=now,
    )
    return log


def edit(db: Session, log: WorkSession, user: User, payload, now: datetime | None = None) -> WorkSession:
    now = now or utcnow()
    check_can_edit_time(user)
    if log.user_id != user.id:
        raise forbidden("NOT_LOG_AUTHOR", "You may only change your own time entries")
    check_edit_window(log, now)

    is_running = log.ended_at is None
    if is_running and log.deleted_at is None:
        if payload.ended_at is not None and payload.if_ended_at_unchanged:
            pass  # a running entry is closed only through Pause (FR-TIME-009)
        if payload.ended_at is not None and not payload.if_ended_at_unchanged:
            raise conflict("USE_PAUSE", "Use the pause endpoint to close a running timer")

    before = snapshot(log)

    if payload.started_at is not None:
        log.started_at = to_utc(payload.started_at)
    if payload.note is not None:
        log.note = payload.note
    if payload.progress_percent is not None:
        log.progress_percent = payload.progress_percent
        task = db.get(Task, log.task_id)
        if task is not None:
            task.progress_percent = payload.progress_percent
    if payload.evidence_url is not None:
        err = validate_evidence_url(payload.evidence_url)
        if err:
            raise unprocessable("UNSAFE_URL", err)
        log.evidence_url = payload.evidence_url

    if not is_running:
        if log.ended_at <= log.started_at:
            raise unprocessable("INVALID_INTERVAL", "ended_at must be after started_at")
        if int((log.ended_at - log.started_at).total_seconds()) > settings.MAX_SESSION_HOURS * 3600:
            raise unprocessable("DURATION_TOO_LONG", "This session is longer than the maximum")
        validate_interval(
            db, user, log.started_at, log.ended_at, now=now, exclude_log_id=log.id
        )
        log.duration_seconds = int((log.ended_at - log.started_at).total_seconds())

    log.edited_at = now
    log.edit_count = (log.edit_count or 0) + 1
    db.flush()

    after = snapshot(log)
    task = db.get(Task, log.task_id)
    audit.record(
        db,
        event_type=EventType.log_edited.value,
        entity_type="task_log",
        entity_id=log.id,
        task_id=log.task_id,
        actor=user,
        summary=f"Time entry #{log.id} on “{task.title if task else 'a task'}” edited",
        before=before,
        after=after,
        meta={"edit_reason": payload.edit_reason, "edit_count": log.edit_count},
        created_at=now,
    )
    return log


def delete(db: Session, log: WorkSession, user: User, now: datetime | None = None) -> WorkSession:
    now = now or utcnow()
    check_can_edit_time(user)
    if log.user_id != user.id:
        raise forbidden("NOT_LOG_AUTHOR", "You may only delete your own time entries")
    check_edit_window(log, now)
    if log.deleted_at is not None:
        return log

    snapshot_before = snapshot(log)
    log.deleted_at = now
    log.deleted_by_id = user.id
    db.flush()

    task = db.get(Task, log.task_id)
    audit.record(
        db,
        event_type=EventType.log_deleted.value,
        entity_type="task_log",
        entity_id=log.id,
        task_id=log.task_id,
        actor=user,
        summary=f"Time entry #{log.id} on “{task.title if task else 'a task'}” deleted",
        before=snapshot_before,
        after={"deleted_at": now},
        created_at=now,
    )
    return log