"""Server-side serializers. The frontend never decides permissions; allowed_actions is computed here."""

from __future__ import annotations

import json
from datetime import date, timedelta

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app import policy
from app.config import settings
from app.models import (
    AuditEvent,
    Folder,
    ResourceLink,
    Task,
    TaskStatus,
    User,
    WorkSession,
    utcnow)
from app.schemas import (
    AuditEventOut,
    FolderOut,
    LinkOut,
    LogOut,
    RunningTimer,
    TaskActor,
    TaskOut)


def actor_out(user: User | None) -> TaskActor | None:
    if user is None:
        return None
    return TaskActor(id=user.id, full_name=user.full_name, role=user.role)


def _json(value: str | None) -> dict | None:
    if not value:
        return None
    try:
        return json.loads(value)
    except json.JSONDecodeError:
        return None


def local_today(now=None) -> date:
    return (now or utcnow()).astimezone(settings.tz).date()


def is_overdue(task: Task, now=None) -> bool:
    if task.due_date is None or task.deleted_at is not None:
        return False
    if task.status == TaskStatus.completed.value:
        return False
    return task.due_date < local_today(now)


def tracked_seconds(db: Session, task_id: int) -> int:
    total = db.scalar(
        select(func.coalesce(func.sum(WorkSession.duration_seconds), 0)).where(
            WorkSession.task_id == task_id,
            WorkSession.deleted_at.is_(None),
            WorkSession.ended_at.is_not(None),
        )
    )
    return int(total or 0)


def running_session_for_task(db: Session, task_id: int) -> WorkSession | None:
    return db.scalar(
        select(WorkSession).where(
            WorkSession.task_id == task_id,
            WorkSession.ended_at.is_(None),
            WorkSession.deleted_at.is_(None),
        )
    )


def running_session_for_user(db: Session, user_id: int) -> WorkSession | None:
    return db.scalar(
        select(WorkSession).where(
            WorkSession.user_id == user_id,
            WorkSession.ended_at.is_(None),
            WorkSession.deleted_at.is_(None),
        )
    )


def seconds_between(start, end) -> int:
    return int((end - start).total_seconds())


def elapsed(session: WorkSession, now=None) -> int:
    now = now or utcnow()
    end = session.ended_at or now
    return max(0, seconds_between(session.started_at, end))


def is_stale(session: WorkSession, now=None) -> bool:
    now = now or utcnow()
    return elapsed(session, now) > settings.MAX_TIMER_HOURS * 3600


# --- allowed actions -------------------------------------------------------

def task_allowed_actions(user: User, task: Task, db: Session, now=None) -> list[str]:
    now = now or utcnow()
    actions: list[str] = []
    if task.deleted_at is not None:
        if policy.can_restore_task(user):
            actions.append("restore")
        return actions

    if policy.can_edit_core_fields(user, task):
        actions.append("edit")
    if policy.can_edit_progress(user, task):
        actions.append("edit_progress")
    if policy.can_change_status(user, task):
        actions.append("change_status")
    if policy.can_delete_task(user, task):
        actions.append("delete")
    if policy.is_lead(user):
        actions.append("reassign")

    if policy.can_track_time(user, task):
        own_running = running_session_for_user(db, user.id)
        if own_running is not None:
            if own_running.task_id == task.id:
                actions.append("pause_timer")
            else:
                actions.append("switch_timer")
        elif task.status != TaskStatus.completed.value:
            actions.append("start_timer")
        actions.append("add_time")
        actions.append("add_note")

    if task.status == TaskStatus.in_review.value and (
        policy.is_reviewer(user) or task.assignee_id == user.id
    ):
        actions.append("review")
    return actions


def log_allowed_actions(user: User, log: WorkSession, db: Session) -> list[str]:
    actions: list[str] = []
    if log.deleted_at is not None:
        return actions
    if log.user_id == user.id and settings.MEMBER_CAN_EDIT_TIME:
        actions.append("edit")
        actions.append("delete")
        if log.ended_at is None:
            actions.append("discard")
    return actions


# --- serializers -----------------------------------------------------------

def task_out(user: User, task: Task, db: Session, now=None, with_actions: bool = True) -> TaskOut:
    now = now or utcnow()
    running = running_session_for_task(db, task.id)
    run_block = None
    if running is not None:
        run_block = RunningTimer(
            log_id=running.id,
            task_id=task.id,
            task_title=task.title,
            started_at=running.started_at,
            elapsed_seconds=elapsed(running, now),
            is_stale=is_stale(running, now),
        )
    log_count = db.scalar(
        select(func.count()).select_from(WorkSession).where(
            WorkSession.task_id == task.id, WorkSession.deleted_at.is_(None)
        )
    )
    return TaskOut(
        id=task.id,
        title=task.title,
        description=task.description,
        category=task.category,
        status=task.status,
        priority=task.priority,
        progress_percent=task.progress_percent,
        due_date=task.due_date,
        estimated_minutes=task.estimated_minutes,
        expected_deliverable=task.expected_deliverable,
        evidence_url=task.evidence_url,
        requires_review=task.requires_review,
        blocked_reason=task.blocked_reason,
        assignee_id=task.assignee_id,
        assignee=actor_out(task.assignee),
        created_by_id=task.created_by_id,
        created_by=actor_out(task.creator),
        completed_at=task.completed_at,
        deleted_at=task.deleted_at,
        created_at=task.created_at,
        updated_at=task.updated_at,
        version=task.version,
        is_overdue=is_overdue(task, now),
        tracked_seconds=tracked_seconds(db, task.id),
        running=run_block,
        allowed_actions=task_allowed_actions(user, task, db, now) if with_actions else [],
        log_count=int(log_count or 0),
    )


def log_out(user: User, log: WorkSession, db: Session) -> LogOut:
    return LogOut(
        id=log.id,
        task_id=log.task_id,
        user_id=log.user_id,
        user=actor_out(log.user),
        entry_type=log.entry_type,
        source=log.source,
        started_at=log.started_at,
        ended_at=log.ended_at,
        duration_seconds=log.duration_seconds,
        note=log.note,
        progress_percent=log.progress_percent,
        evidence_url=log.evidence_url,
        edit_count=log.edit_count,
        edited_at=log.edited_at,
        deleted_at=log.deleted_at,
        created_at=log.created_at,
        allowed_actions=log_allowed_actions(user, log, db),
    )


def audit_out(event: AuditEvent) -> AuditEventOut:
    return AuditEventOut(
        id=event.id,
        request_id=event.request_id,
        event_type=event.event_type,
        actor_id=event.actor_id,
        actor_name=event.actor_name,
        entity_type=event.entity_type,
        entity_id=event.entity_id,
        task_id=event.task_id,
        summary=event.summary,
        before=_json(event.before_json),
        after=_json(event.after_json),
        meta=_json(event.meta_json),
        created_at=event.created_at,
    )


def link_out(user: User, link: ResourceLink) -> LinkOut:
    from sqlalchemy import select as _s

    tags = link.tags if hasattr(link, "tags") else []
    actions: list[str] = []
    if policy.can_edit_link(user, link):
        actions.append("edit")
        actions.append("delete")
    return LinkOut(
        id=link.id,
        folder_id=link.folder_id,
        folder_name=link.folder.name if link.folder else None,
        folder_visibility=link.folder.visibility if link.folder else None,
        title=link.title,
        url=link.url,
        description=link.description,
        tags=[t.tag for t in tags],
        created_by_id=link.created_by_id,
        created_at=link.created_at,
        updated_at=link.updated_at,
        allowed_actions=actions,
    )


def folder_out(user: User, folder: Folder, db: Session) -> FolderOut:
    from sqlalchemy import func as _f

    link_count = db.scalar(
        _f_count(db, ResourceLink, ResourceLink.folder_id == folder.id)
    ) or 0
    child_count = db.scalar(
        _f_count(db, Folder, Folder.parent_id == folder.id, Folder.deleted_at.is_(None))
    ) or 0
    actions = ["edit", "delete", "move"] if policy.can_manage_folder(user) else []
    return FolderOut(
        id=folder.id,
        name=folder.name,
        description=folder.description,
        parent_id=folder.parent_id,
        visibility=folder.visibility,
        depth=folder.depth,
        created_at=folder.created_at,
        link_count=int(link_count),
        child_count=int(child_count),
        allowed_actions=actions,
    )


def _f_count(db: Session, model, *conditions):
    return (
        select(func.count())
        .select_from(model)
        .where(*conditions, model.deleted_at.is_(None))
    )