"""Server-side serializers. The frontend never decides permissions; allowed_actions is computed here."""

from __future__ import annotations

import json
from datetime import date, timedelta

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app import aggregate, policy
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
    PersonRef,
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
    """Closed seconds plus whatever is accruing on an open timer right now."""
    return aggregate.tracked_seconds(db, task_id)


class TaskContext:
    """Preloaded per-task lookups for one page of results.

    Without it `task_out` issued four queries per row -- a running-timer lookup,
    a log count, a tracked-seconds sum and another running-timer lookup for the
    allowed-action decision. A 25-row page cost roughly a hundred queries.
    """

    __slots__ = ("user", "now", "running", "mine", "tracked", "log_counts")

    def __init__(self, db: Session, user: User, tasks, now=None):
        self.user = user
        self.now = now or utcnow()
        ids = [t.id for t in tasks]
        self.running = aggregate.running_by_task(db, ids)
        self.mine = aggregate.running_by_task_for_user(db, ids, user.id)
        self.tracked = aggregate.tracked_seconds_by_task(db, ids)
        self.log_counts = aggregate.log_counts_by_task(db, ids)


def running_timer_out(task: Task, log: WorkSession, viewer_id: int, now) -> RunningTimer:
    return RunningTimer(
        log_id=log.id,
        task_id=task.id,
        task_title=task.title,
        started_at=log.started_at,
        elapsed_seconds=elapsed(log, now),
        is_stale=is_stale(log, now),
        user_id=log.user_id,
        user=actor_out(log.user),
        is_mine=log.user_id == viewer_id,
    )


def running_session_for_task(db: Session, task_id: int, user_id: int | None = None) -> WorkSession | None:
    stmt = select(WorkSession).where(
        WorkSession.task_id == task_id,
        WorkSession.ended_at.is_(None),
        WorkSession.deleted_at.is_(None),
    )
    if user_id is not None:
        stmt = stmt.where(WorkSession.user_id == user_id)
    return db.scalar(stmt)


def running_sessions_for_user(db: Session, user_id: int) -> list[WorkSession]:
    """Every timer this person has open right now. Timers are concurrent."""
    return list(
        db.scalars(
            select(WorkSession)
            .where(
                WorkSession.user_id == user_id,
                WorkSession.ended_at.is_(None),
                WorkSession.deleted_at.is_(None),
            )
            .order_by(WorkSession.started_at.asc(), WorkSession.id.asc())
        ).all()
    )


def running_session_for_user(db: Session, user_id: int) -> WorkSession | None:
    """The most recently opened running timer, or None."""
    sessions = running_sessions_for_user(db, user_id)
    return sessions[-1] if sessions else None


def running_session_for_user_task(
    db: Session, user_id: int, task_id: int
) -> WorkSession | None:
    return db.scalar(
        select(WorkSession).where(
            WorkSession.user_id == user_id,
            WorkSession.task_id == task_id,
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

def task_allowed_actions(
    user: User,
    task: Task,
    db: Session,
    now=None,
    ctx: "TaskContext | None" = None,
) -> list[str]:
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
    if policy.can_reassign(user):
        actions.append("reassign")

    if policy.can_track_time(user, task):
        if ctx is not None:
            own_running = ctx.mine.get(task.id)
        else:
            own_running = running_session_for_user_task(db, user.id, task.id)
        if own_running is not None:
            actions.append("pause_timer")
        elif task.status != TaskStatus.completed.value:
            # Starting here while other timers run is allowed: a person can
            # genuinely be working on two things at once.
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

def task_out(
    user: User,
    task: Task,
    db: Session,
    now=None,
    with_actions: bool = True,
    ctx: "TaskContext | None" = None,
) -> TaskOut:
    now = now or utcnow()
    if ctx is None:
        ctx = TaskContext(db, user, [task], now)

    # `running` is the caller's own timer and nothing else. It used to be any
    # user's timer on the task, which made a viewer offer to pause a colleague's
    # clock -- the id went straight into POST /timer/pause.
    mine = ctx.mine.get(task.id)
    run_block = running_timer_out(task, mine, user.id, now) if mine is not None else None
    others = [
        running_timer_out(task, log, user.id, now)
        for log in ctx.running.get(task.id, [])
        if log.id != (mine.id if mine is not None else None)
    ]
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
        tracked_seconds=ctx.tracked.get(task.id, 0),
        running=run_block,
        other_runners=others,
        allowed_actions=task_allowed_actions(user, task, db, now, ctx) if with_actions else [],
        log_count=ctx.log_counts.get(task.id, 0),
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
    # entity_id is an INTEGER column and every audited entity has a numeric id.
    # If a row ever holds something else, show it as an unusable reference rather
    # than raising: one bad row must not blank the whole activity feed.
    entity_id = event.entity_id if isinstance(event.entity_id, int) else None
    return AuditEventOut(
        id=event.id,
        request_id=event.request_id,
        event_type=event.event_type,
        actor_id=event.actor_id,
        actor_name=event.actor_name,
        entity_type=event.entity_type,
        entity_id=entity_id,
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
        task_id=link.task_id,
        title=link.title,
        url=link.url,
        description=link.description,
        tags=[t.tag for t in tags],
        created_by_id=link.created_by_id,
        created_by=(
            PersonRef(
                id=link.creator.id,
                full_name=link.creator.full_name,
                display_name=link.creator.display_name,
                avatar_url=link.creator.avatar_url,
                avatar_color=link.creator.avatar_color,
                role=link.creator.role,
            )
            if link.creator
            else None
        ),
        created_at=link.created_at,
        updated_at=link.updated_at,
        allowed_actions=actions,
    )


def folder_counts(db: Session, folder_ids: list[int]) -> dict[int, dict[str, int]]:
    """Link and child counts for a whole page of folders in two queries."""
    if not folder_ids:
        return {}
    links = db.execute(
        select(ResourceLink.folder_id, func.count())
        .where(ResourceLink.folder_id.in_(folder_ids), ResourceLink.deleted_at.is_(None))
        .group_by(ResourceLink.folder_id)
    ).all()
    children = db.execute(
        select(Folder.parent_id, func.count())
        .where(Folder.parent_id.in_(folder_ids), Folder.deleted_at.is_(None))
        .group_by(Folder.parent_id)
    ).all()
    out = {fid: {"link_count": 0, "child_count": 0} for fid in folder_ids}
    for fid, n in links:
        if fid in out:
            out[fid]["link_count"] = int(n or 0)
    for pid, n in children:
        if pid in out:
            out[pid]["child_count"] = int(n or 0)
    return out


def folder_out(
    user: User, folder: Folder, db: Session, counts: dict[str, int] | None = None
) -> FolderOut:
    if counts is None:
        counts = folder_counts(db, [folder.id]).get(folder.id, {})
    actions = ["edit", "delete", "move"] if policy.can_manage_folder(user) else []
    return FolderOut(
        id=folder.id,
        name=folder.name,
        description=folder.description,
        parent_id=folder.parent_id,
        visibility=folder.visibility,
        depth=folder.depth,
        created_at=folder.created_at,
        link_count=int(counts.get("link_count", 0)),
        child_count=int(counts.get("child_count", 0)),
        allowed_actions=actions,
    )