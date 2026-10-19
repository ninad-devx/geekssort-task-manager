from __future__ import annotations

import re
from datetime import timedelta

from fastapi import APIRouter, Depends, Query, Request
from sqlalchemy import delete, func, select
from sqlalchemy.orm import Session

from app import audit, policy, timelog
from app.aggregate import live_seconds_expr
from app.config import settings
from app.db import get_db, write_tx
from app.deps import CurrentUser, get_current_user, require_admin
from app.errors import conflict, forbidden, not_found, unprocessable
from app.models import (
    AuditEvent,
    EventType,
    Role,
    SessionRow,
    Task,
    TaskStatus,
    User,
    WorkSession,
    utcnow)
from app.schemas import (
    DeactivateIn,
    DirectoryEntry,
    PasswordResetIn,
    UserCreateIn,
    UserCreatedOut,
    UserOut,
    UserUpdateIn,
)
from app.security import generate_temp_password, hash_password, validate_password, validate_url
from app.serializers import (
    audit_out,
    elapsed,
    is_stale,
    local_today,
    worklist_rows,
)

router = APIRouter(prefix="/users", tags=["users"])

OPEN_STATUSES = (
    TaskStatus.todo.value,
    TaskStatus.in_progress.value,
    TaskStatus.blocked.value,
    TaskStatus.in_review.value,
)


def _out(user: User) -> UserOut:
    return UserOut(
        id=user.id,
        email=user.email,
        full_name=user.full_name,
        display_name=user.display_name,
        avatar_url=user.avatar_url,
        avatar_color=user.avatar_color,
        role=user.role,
        is_admin=user.is_admin,
        can_review=user.can_review,
        is_active=user.is_active,
        must_change_password=user.must_change_password,
        created_at=user.created_at,
    )


def _created_out(user: User, temporary: str | None) -> UserCreatedOut:
    return UserCreatedOut(
        id=user.id,
        email=user.email,
        full_name=user.full_name,
        display_name=user.display_name,
        avatar_url=user.avatar_url,
        avatar_color=user.avatar_color,
        role=user.role,
        is_admin=user.is_admin,
        can_review=user.can_review,
        is_active=user.is_active,
        must_change_password=user.must_change_password,
        created_at=user.created_at,
        temporary_password=temporary,
    )


def _active_admin_count(db: Session, exclude_id: int | None = None) -> int:
    q = select(func.count()).select_from(User).where(User.is_admin.is_(True), User.is_active.is_(True))
    if exclude_id is not None:
        q = q.where(User.id != exclude_id)
    return int(db.scalar(q) or 0)


def _open_task_count(db: Session, user_id: int) -> int:
    return int(
        db.scalar(
            select(func.count()).select_from(Task).where(
                Task.assignee_id == user_id,
                Task.deleted_at.is_(None),
                Task.status != TaskStatus.completed.value,
            )
        )
        or 0
    )


@router.get("/directory", response_model=list[DirectoryEntry])
def directory(current: CurrentUser = Depends(get_current_user), db: Session = Depends(get_db)):
    """FR-USER-006: never returns email or flags."""
    rows = db.scalars(select(User).order_by(User.full_name)).all()
    return [
        DirectoryEntry(
            id=u.id,
            full_name=u.full_name,
            display_name=u.display_name,
            avatar_url=u.avatar_url,
            avatar_color=u.avatar_color,
            role=u.role,
            is_active=u.is_active,
        )
        for u in rows
    ]


@router.get("/{user_id}/profile")
def user_profile(
    user_id: int,
    current: CurrentUser = Depends(get_current_user),
    db: Session = Depends(get_db),
    days: int = Query(default=30, ge=1, le=90),
    carry_days: int = Query(default=7, ge=0, le=365),
):
    """One person's whole working picture: today's board, their totals, and a
    day-by-day activity strip.

    Everyone may open their own. A CEO or team lead may open anyone's, which is
    what makes the numbers on the executive cards drillable: a lead who reads
    "42 hours" needs to land on *whose* 42 hours.

    Object-level denial is a 404, not a 403, so member ids cannot be walked
    (rule D-10) -- the same answer as asking for a task you cannot see.
    """
    target = db.get(User, user_id)
    if target is None:
        raise not_found("USER_NOT_FOUND", "User not found")
    if target.id != current.user.id and not policy.can_view_all_tasks(current.user):
        raise not_found("USER_NOT_FOUND", "User not found")

    from app.routers.dashboard import _daily_activity, _window_local_days, end_of_day_utc, start_of_day_utc
    from app.routers.tasks import ACTIVE_STATUSES

    today = local_today()
    start, end = start_of_day_utc(today - timedelta(days=days - 1)), end_of_day_utc(today)

    tasks = select(Task).where(Task.deleted_at.is_(None), Task.assignee_id == target.id)

    def count(*conditions) -> int:
        return int(db.scalar(select(func.count()).select_from(tasks.where(*conditions).subquery())) or 0)

    open_clause = Task.status != TaskStatus.completed.value
    day_start, day_end = start_of_day_utc(today), end_of_day_utc(today)

    by_status = {
        status.value: count(Task.status == status.value) for status in TaskStatus
    }
    total_seconds = int(db.scalar(select(live_seconds_expr()).where(
        WorkSession.user_id == target.id, WorkSession.deleted_at.is_(None)
    )) or 0)

    running = db.scalars(
        select(WorkSession).where(
            WorkSession.user_id == target.id,
            WorkSession.ended_at.is_(None),
            WorkSession.deleted_at.is_(None),
        )
    ).all()

    # Recent trail: what this person actually did. Deliberately actor-based
    # rather than "everything that happened to their tasks", so opening a
    # profile can never surface a colleague's actions or a company-level record.
    recent = db.scalars(
        select(AuditEvent)
        .where(AuditEvent.actor_id == target.id)
        .order_by(AuditEvent.created_at.desc(), AuditEvent.id.desc())
        .limit(20)
    ).all()

    return {
        "user": {
            "id": target.id,
            "full_name": target.full_name,
            "display_name": target.display_name,
            "avatar_url": target.avatar_url,
            "avatar_color": target.avatar_color,
            "role": target.role,
            "is_active": target.is_active,
            "can_review": target.can_review,
            "is_admin": target.is_admin,
            "created_at": target.created_at,
        },
        "is_self": target.id == current.user.id,
        "server_time": utcnow(),
        "app_timezone": settings.APP_TIMEZONE,
        "days": days,
        "range": {"from": start, "to": end},
        "counts": {
            "total": sum(by_status.values()),
            "by_status": by_status,
            "open": sum(by_status[s] for s in OPEN_STATUSES),
            "in_progress": by_status[TaskStatus.in_progress.value],
            "blocked": by_status[TaskStatus.blocked.value],
            "in_review": by_status[TaskStatus.in_review.value],
            "overdue": count(
                Task.due_date.is_not(None),
                Task.due_date < today,
                Task.due_date >= today - timedelta(days=carry_days),
                open_clause,
            ),
            "due_today": count(Task.due_date == today, open_clause),
            # Older than the carry-forward window: real, but no longer today's
            # problem. Shown separately so a small "overdue" number is honest.
            "older_overdue": count(
                Task.due_date.is_not(None),
                Task.due_date < today,
                Task.due_date < today - timedelta(days=carry_days),
                open_clause,
            ),
            "carry_days": carry_days,
            "completed_today": count(
                Task.completed_at >= day_start, Task.completed_at <= day_end
            ),
            "completed_total": by_status[TaskStatus.completed.value],
            "tracked_seconds": int(
                db.scalar(
                    select(live_seconds_expr()).where(
                        WorkSession.user_id == target.id,
                        WorkSession.deleted_at.is_(None),
                        WorkSession.started_at >= start,
                        WorkSession.started_at <= end,
                    )
                )
                or 0
            ),
            "tracked_seconds_total": total_seconds,
        },
        "daily": _daily_activity(db, target.id, start, end),
        "days_in_range": [str(d) for d in _window_local_days(start, end)],
        "tasks": {
            "in_progress": worklist_rows(
                db, tasks.where(Task.status == TaskStatus.in_progress.value), today
            ),
            "overdue": worklist_rows(
                db,
                tasks.where(
                    Task.due_date.is_not(None),
                    Task.due_date < today,
                    Task.due_date >= today - timedelta(days=carry_days),
                    open_clause,
                ),
                today,
            ),
            "due_today": worklist_rows(db, tasks.where(Task.due_date == today, open_clause), today),
            "completed_today": worklist_rows(
                db,
                tasks.where(
                    Task.status == TaskStatus.completed.value,
                    Task.completed_at >= day_start,
                    Task.completed_at <= day_end,
                ),
                today,
            ),
        },
        "active_statuses": list(ACTIVE_STATUSES),
        "running": [
            {
                "log_id": log.id,
                "task_id": log.task_id,
                "task_title": task.title if (task := db.get(Task, log.task_id)) else "Task",
                "started_at": log.started_at,
                "elapsed_seconds": elapsed(log),
                "is_stale": is_stale(log),
            }
            for log in running
        ],
        "recent_activity": [audit_out(event) for event in recent],
    }


@router.get("", response_model=list[UserOut])
def list_users(current: CurrentUser = Depends(require_admin), db: Session = Depends(get_db)):
    rows = db.scalars(select(User).order_by(User.full_name)).all()
    return [_out(u) for u in rows]


@router.post("", response_model=UserCreatedOut, status_code=201)
def create_user(
    payload: UserCreateIn,
    current: CurrentUser = Depends(require_admin),
):
    email = payload.email.strip().lower()
    role = payload.role.value if isinstance(payload.role, Role) else str(payload.role)
    temporary: str | None = None
    problem = None
    if payload.password:
        problem = validate_password(payload.password, email)
    else:
        temporary = generate_temp_password()
        problem = validate_password(temporary, email)
    if problem:
        raise unprocessable("WEAK_PASSWORD", problem)

    with write_tx() as db:
        if db.scalar(select(User).where(User.email == email)):
            raise conflict("EMAIL_TAKEN", "That email is already registered")
        now = utcnow()
        user = User(
            email=email,
            full_name=payload.full_name.strip(),
            password_hash=hash_password(payload.password or temporary),
            role=role,
            is_admin=payload.is_admin,
            can_review=(role == Role.team_lead.value) if payload.can_review is None else payload.can_review,
            is_active=True,
            must_change_password=payload.password is None,
            created_at=now,
            updated_at=now,
        )
        db.add(user)
        db.flush()
        audit.record(
            db,
            event_type=EventType.user_created.value,
            entity_type="user",
            entity_id=user.id,
            actor=current.user,
            summary=f"User {user.full_name} created with role {role}",
            after={"email": email, "role": role, "is_admin": user.is_admin, "can_review": user.can_review},
            created_at=now,
        )
        result = _created_out(user, temporary)
    return result


PROFILE_FIELDS = ("display_name", "avatar_url", "avatar_color")


def _is_profile_only(payload: UserUpdateIn) -> bool:
    """True when the caller only wants to edit their own display name or picture."""
    fields = set(payload.model_dump(exclude_unset=True))
    return bool(fields) and fields <= set(PROFILE_FIELDS)


@router.patch("/{user_id}", response_model=UserOut)
def update_user(
    user_id: int,
    payload: UserUpdateIn,
    current: CurrentUser = Depends(get_current_user),
):
    # Everyone may edit their own picture and display name. Anything else on
    # this endpoint — role, admin flag, activation, another person's profile —
    # still requires the admin flag.
    if current.user.id == user_id and _is_profile_only(payload):
        return _update_own_profile(current, payload)
    return _admin_update_user(user_id, payload, current)


def _apply_profile(db: Session, target: User, payload: UserUpdateIn) -> None:
    """Copy the profile fields the caller actually sent.

    `model_fields_set` is what distinguishes "not mentioned" from "explicitly
    null", so an omitted field is left alone while `null` genuinely clears it.
    """
    sent = payload.model_fields_set
    if "display_name" in sent:
        target.display_name = (payload.display_name or "").strip() or None
    if "avatar_url" in sent:
        url = (payload.avatar_url or "").strip()
        if url:
            problem = validate_url(url)
            if problem:
                raise unprocessable("INVALID_AVATAR_URL", problem)
        target.avatar_url = url or None
    if "avatar_color" in sent:
        color = (payload.avatar_color or "").strip()
        if color and not re.fullmatch(r"#[0-9a-fA-F]{6}", color):
            raise unprocessable("INVALID_AVATAR_COLOR", "Colour must be a hex value like #4f46e5")
        target.avatar_color = color or None


def _update_own_profile(current: CurrentUser, payload: UserUpdateIn) -> UserOut:
    with write_tx() as db:
        target = db.get(User, current.user.id)
        if target is None:
            raise not_found("USER_NOT_FOUND", "User not found")
        _apply_profile(db, target, payload)
        target.updated_at = utcnow()
        db.flush()
        return _out(target)


def _admin_update_user(
    user_id: int,
    payload: UserUpdateIn,
    current: CurrentUser,
) -> UserOut:
    if not current.user.is_admin:
        raise forbidden("ADMIN_ONLY", "This action requires the admin flag")
    with write_tx() as db:
        target = db.get(User, user_id)
        if target is None:
            raise not_found("USER_NOT_FOUND", "User not found")

        before = {
            "full_name": target.full_name,
            "display_name": target.display_name,
            "role": target.role,
            "is_admin": target.is_admin,
            "can_review": target.can_review,
            "is_active": target.is_active,
        }
        new_role = payload.role.value if payload.role else None
        loses_admin = target.is_admin and (
            (payload.is_admin is False) or (new_role is not None and new_role != Role.team_lead.value and payload.is_admin is None)
        )
        self_target = target.id == current.user.id

        # The last-admin invariant is checked first: it holds regardless of who is asking.
        if loses_admin and _active_admin_count(db, exclude_id=target.id) == 0:
            raise conflict("LAST_ADMIN", "The last active admin cannot be demoted or deactivated")

        if self_target and (payload.role or payload.is_admin is not None or payload.is_active is not None):
            if (payload.role and payload.role.value != target.role) or payload.is_admin is not None:
                raise conflict("CANNOT_EDIT_SELF", "You cannot change your own role or admin flag")

        if payload.full_name is not None:
            target.full_name = payload.full_name.strip()
        _apply_profile(db, target, payload)
        if new_role is not None:
            target.role = new_role
            if payload.can_review is None:
                target.can_review = new_role == Role.team_lead.value
        if payload.is_admin is not None:
            target.is_admin = payload.is_admin
        if payload.can_review is not None:
            target.can_review = payload.can_review

        if payload.is_active is False:
            if target.is_admin and _active_admin_count(db, exclude_id=target.id) == 0:
                raise conflict("LAST_ADMIN", "The last active admin cannot be deactivated")
            if self_target:
                raise conflict("CANNOT_DEACTIVATE_SELF", "You cannot deactivate your own account")
            _deactivate(db, target, current.user, None)
        elif payload.is_active is True and not target.is_active:
            target.is_active = True
            audit.record(
                db,
                event_type=EventType.user_reactivated.value,
                entity_type="user",
                entity_id=target.id,
                actor=current.user,
                summary=f"User {target.full_name} reactivated",
            )

        after = {
            "full_name": target.full_name,
            "display_name": target.display_name,
            "role": target.role,
            "is_admin": target.is_admin,
            "can_review": target.can_review,
            "is_active": target.is_active,
        }
        if before != after:
            audit.record(
                db,
                event_type=EventType.user_updated.value,
                entity_type="user",
                entity_id=target.id,
                actor=current.user,
                summary=f"User {target.full_name} updated",
                before=before,
                after=after,
            )
        target.updated_at = utcnow()
        db.flush()
        return _out(target)


def _deactivate(db: Session, target: User, actor: User, reassign_to: int | None) -> None:
    now = utcnow()
    open_tasks = int(
        db.scalar(
            select(func.count()).select_from(Task).where(
                Task.assignee_id == target.id,
                Task.deleted_at.is_(None),
                Task.status != TaskStatus.completed.value,
            )
        )
        or 0
    )
    if open_tasks and not reassign_to:
        raise conflict("HAS_OPEN_TASKS", "Reassign the open tasks first", open_task_count=open_tasks)

    if reassign_to:
        successor = db.get(User, reassign_to)
        if successor is None or not successor.is_active:
            raise unprocessable("INVALID_REASSIGN_TARGET", "The reassignment target must be an active user")
        tasks = db.scalars(
            select(Task).where(
                Task.assignee_id == target.id,
                Task.deleted_at.is_(None),
                Task.status != TaskStatus.completed.value,
            )
        ).all()
        for task in tasks:
            previous_id = task.assignee_id
            timelog.close_running_for_task(db, task, now, actor, "assignee deactivated")
            task.assignee_id = successor.id
            task.version += 1
            audit.record(
                db,
                event_type=EventType.task_assigned.value,
                entity_type="task",
                entity_id=task.id,
                task_id=task.id,
                actor=actor,
                summary=f"“{task.title}” reassigned to {successor.full_name} (user deactivated)",
                before={"assignee_id": previous_id},
                after={"assignee_id": successor.id},
            )

    timelog.close_running_for_user(db, target.id, now, "user deactivated")
    target.is_active = False
    target.updated_at = now
    db.execute(delete(SessionRow).where(SessionRow.user_id == target.id))
    audit.record(
        db,
        event_type=EventType.user_deactivated.value,
        entity_type="user",
        entity_id=target.id,
        actor=actor,
        summary=f"User {target.full_name} deactivated",
        before={"is_active": True},
        after={"is_active": False, "reassigned_tasks": bool(reassign_to)},
    )


@router.post("/{user_id}/deactivate", response_model=UserOut)
def deactivate_user(
    user_id: int,
    payload: DeactivateIn,
    current: CurrentUser = Depends(require_admin),
):
    with write_tx() as db:
        target = db.get(User, user_id)
        if target is None:
            raise not_found("USER_NOT_FOUND", "User not found")
        if target.id == current.user.id:
            raise conflict("CANNOT_DEACTIVATE_SELF", "You cannot deactivate your own account")
        if not target.is_active:
            raise conflict("ALREADY_INACTIVE", "That user is already inactive")
        if target.is_admin and _active_admin_count(db, exclude_id=target.id) == 0:
            raise conflict("LAST_ADMIN", "The last active admin cannot be deactivated")
        _deactivate(db, target, current.user, payload.reassign_to_user_id)
        db.flush()
        return _out(target)


@router.post("/{user_id}/reset-password", response_model=UserCreatedOut)
def reset_password(
    user_id: int,
    payload: PasswordResetIn,
    current: CurrentUser = Depends(require_admin),
):
    with write_tx() as db:
        target = db.get(User, user_id)
        if target is None:
            raise not_found("USER_NOT_FOUND", "User not found")
        password = payload.new_password or generate_temp_password()
        problem = validate_password(password, target.email)
        if problem:
            raise unprocessable("WEAK_PASSWORD", problem)
        now = utcnow()
        is_self = target.id == current.user.id
        target.password_hash = hash_password(password)
        # Do not force must_change_password on the admin's own active session
        # (or when an explicit password was set), otherwise the admin UI is
        # immediately kicked out before they can copy the password.
        target.must_change_password = (payload.new_password is None) and (not is_self)
        target.updated_at = now
        if is_self:
            db.execute(
                delete(SessionRow).where(
                    SessionRow.user_id == target.id,
                    SessionRow.id != current.session.id,
                )
            )
        else:
            db.execute(delete(SessionRow).where(SessionRow.user_id == target.id))
        audit.record(
            db,
            event_type=EventType.password_reset.value,
            entity_type="user",
            entity_id=target.id,
            actor=current.user,
            summary=f"Password reset for {target.full_name}",
            after={"must_change_password": target.must_change_password},
            created_at=now,
        )
        db.flush()
        return _created_out(target, password)