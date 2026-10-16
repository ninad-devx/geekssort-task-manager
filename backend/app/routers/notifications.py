"""Assignment notifications, derived from the audit log.

There is deliberately no notifications table. The audit log is already the
append-only record of who did what, so an assignment is simply a
`task.assigned` / `task.created` event on a task whose current assignee is the
caller. Deriving the feed keeps one source of truth: the notification can never
disagree with the history.

"New" is decided by a `since` timestamp the client sends — that marker is
per-device viewing state, not company record, so it stays out of the database
and out of the audit trail.
"""

from __future__ import annotations

import json
from datetime import datetime

from fastapi import APIRouter, Depends, Query
from sqlalchemy import select
from sqlalchemy.orm import Session

from app import policy
from app.db import get_db
from app.deps import CurrentUser, get_current_user
from app.models import AuditEvent, EventType, Task, utcnow
from app.schemas import NotificationListOut, NotificationOut

router = APIRouter(prefix="/notifications", tags=["notifications"])

ASSIGNMENT_EVENTS = (EventType.task_assigned.value, EventType.task_created.value)
REMINDER_EVENT = EventType.task_reminder_sent.value
# "Nudge me about this" is as much an assignment as handing the task over, so
# the feed carries both under the same unread marker.
NOTIFY_EVENTS = ASSIGNMENT_EVENTS + (REMINDER_EVENT,)


@router.get("", response_model=NotificationListOut)
def list_notifications(
    current: CurrentUser = Depends(get_current_user),
    db: Session = Depends(get_db),
    since: datetime | None = Query(default=None),
    limit: int = Query(default=50, ge=1, le=200),
):
    user = current.user

    stmt = select(AuditEvent).join(Task, Task.id == AuditEvent.task_id).where(
        AuditEvent.event_type.in_(NOTIFY_EVENTS),
        AuditEvent.task_id.is_not(None),
    )
    # A member may only ever be told about work they can actually see.
    scope = policy.task_query_scope(user)
    if scope is not None:
        stmt = stmt.where(scope)
    if since is not None:
        stmt = stmt.where(AuditEvent.created_at > since)

    rows = db.scalars(
        stmt.order_by(AuditEvent.created_at.desc(), AuditEvent.id.desc()).limit(limit)
    ).all()

    items: list[NotificationOut] = []
    seen_tasks: set[int] = set()
    loaded: dict[int, Task | None] = {}

    for event in rows:
        task_id = event.task_id
        if task_id not in loaded:
            loaded[task_id] = db.get(Task, task_id)
        task = loaded[task_id]
        if task is None or task.deleted_at is not None:
            continue
        if task.assignee_id != user.id:
            continue  # not about them any more
        if event.actor_id == user.id:
            continue  # they did it themselves; that is not a notification
        # A reassignment emits several events; only the latest one matters.
        if task_id in seen_tasks:
            continue
        seen_tasks.add(task_id)

        is_reminder = event.event_type == REMINDER_EVENT
        detail = ""
        if is_reminder and event.meta_json:
            try:
                message = json.loads(event.meta_json).get("message")
            except (json.JSONDecodeError, AttributeError):
                message = None
            if message:
                detail = message

        items.append(
            NotificationOut(
                id=event.id,
                task_id=task.id,
                task_title=task.title,
                task_status=task.status,
                actor_name=event.actor_name,
                actor_id=event.actor_id,
                created_at=event.created_at,
                # Everything this endpoint returns is newer than the watermark
                # the client sent -- or the client sent no watermark at all and
                # has therefore displayed nothing. Either way these are new to
                # that device. `unread` below counts exactly this list, so the
                # badge and the flag can no longer contradict each other.
                is_new=True,
                is_reminder=is_reminder,
                message=detail or None,
            )
        )

    return NotificationListOut(
        items=items,
        unread=len(items),
        server_time=utcnow(),
    )