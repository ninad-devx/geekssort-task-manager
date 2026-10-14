from __future__ import annotations

from datetime import date, datetime, time

from fastapi import APIRouter, Depends, Query
from sqlalchemy import Select, func, or_, select
from sqlalchemy.orm import Session

from app import policy
from app.config import settings
from app.db import get_db
from app.deps import CurrentUser, get_current_user
from app.errors import forbidden
from app.models import AuditEvent, Task
from app.schemas import AuditListOut
from app.serializers import audit_out
from app.timelog import to_utc

router = APIRouter(prefix="/audit", tags=["audit"])


def _scope(current: CurrentUser) -> Select:
    stmt = select(AuditEvent)
    if policy.can_view_all_tasks(current.user):
        return stmt
    # members see events on their own tasks (7.2)
    return stmt.where(
        or_(
            AuditEvent.actor_id == current.user.id,
            AuditEvent.task_id.in_(select(Task.id).where(Task.assignee_id == current.user.id)),
        )
    )


@router.get("", response_model=AuditListOut)
def list_audit(
    current: CurrentUser = Depends(get_current_user),
    db: Session = Depends(get_db),
    task_id: int | None = Query(default=None),
    user_id: int | None = Query(default=None),
    event_type: str | None = Query(default=None),
    actor_id: int | None = Query(default=None),
    date_from: date | None = Query(default=None),
    date_to: date | None = Query(default=None),
    q: str | None = Query(default=None),
    page: int = Query(default=1, ge=1),
    page_size: int = Query(default=50, ge=1, le=200),
):
    stmt = _scope(current)
    if task_id is not None:
        stmt = stmt.where(AuditEvent.task_id == task_id)
    if user_id is not None:
        # member filter: only their own events
        stmt = stmt.where(AuditEvent.actor_id == user_id)
    if actor_id is not None:
        stmt = stmt.where(AuditEvent.actor_id == actor_id)
    if event_type:
        stmt = stmt.where(AuditEvent.event_type == event_type)
    if date_from:
        stmt = stmt.where(
            AuditEvent.created_at >= to_utc(datetime.combine(date_from, time.min))
        )
    if date_to:
        stmt = stmt.where(
            AuditEvent.created_at <= to_utc(datetime.combine(date_to, time.max))
        )
    if q:
        stmt = stmt.where(AuditEvent.summary.ilike(f"%{q.strip()}%"))

    stmt = stmt.order_by(AuditEvent.created_at.desc(), AuditEvent.id.desc())
    total = int(db.scalar(select(func.count()).select_from(stmt.subquery())) or 0)
    rows = db.scalars(stmt.offset((page - 1) * page_size).limit(page_size)).all()
    return AuditListOut(
        items=[audit_out(r) for r in rows],
        total=total,
        page=page,
        page_size=page_size,
    )