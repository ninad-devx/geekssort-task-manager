from __future__ import annotations

from datetime import date, datetime, timedelta
from typing import Literal

from fastapi import APIRouter, Depends, Query
from sqlalchemy import Select, and_, case, func, or_, select
from sqlalchemy.orm import Session

from app import audit, policy, timelog, workflow
from app.config import settings
from app.db import get_db, write_tx
from app.deps import CurrentUser, get_current_user
from app.errors import conflict, forbidden, not_found, unprocessable
from app.models import EventType, Priority, Task, TaskStatus, User, utcnow
from app.schemas import (
    CORE_FIELDS,
    PROGRESS_FIELDS,
    LinkOut,
    PersonRef,
    PersonTasksOut,
    ReassignIn,
    RemindIn,
    ReminderOut,
    StatusChangeIn,
    TaskBoardOut,
    TaskCreateIn,
    TaskListOut,
    TaskOut,
    TaskUpdateIn,
)
from app.security import escape_like, validate_evidence_url
from app.serializers import TaskContext, is_overdue, local_today, task_out, tracked_seconds

router = APIRouter(prefix="/tasks", tags=["tasks"])

OPEN_STATUSES = (
    TaskStatus.todo.value,
    TaskStatus.in_progress.value,
    TaskStatus.blocked.value,
    TaskStatus.in_review.value,
)

# Narrow Literals rather than free strings. `?status=banana` used to answer 200
# with zero rows, and `?order=DROP` answered 200 as if it were `asc` -- a typo
# was indistinguishable from a real filter that simply matched nothing.
SortKey = Literal["due", "created", "updated", "title", "priority", "status"]
SortOrder = Literal["asc", "desc"]
StatusFilter = Literal["todo", "in_progress", "blocked", "in_review", "completed"]
PriorityFilter = Literal["low", "medium", "high", "urgent"]

SORT_COLUMNS = {
    "due": Task.due_date,
    "created": Task.created_at,
    "updated": Task.updated_at,
    "title": Task.title,
    "status": Task.status,
}


def priority_rank():
    """Sort by urgency, not by alphabet.

    `priority` is a string column, so `ORDER BY priority` ranked
    high < low < medium < urgent -- urgent work sorted last.
    """
    return case(
        *[(Task.priority == p.value, i) for i, p in enumerate(Priority)],
        else_=len(Priority),
    )


def _base_query(current: CurrentUser) -> Select:
    q = select(Task)
    if not policy.can_view_all_tasks(current.user):
        q = q.where(
            or_(Task.assignee_id == current.user.id, Task.created_by_id == current.user.id)
        )
    return q


def _load_for_write(current: CurrentUser, db: Session, task_id: int) -> Task:
    task = db.get(Task, task_id)
    if task is None or not policy.can_see_task(current.user, task):
        raise not_found("TASK_NOT_FOUND", "Task not found")
    return task


def _validate_evidence(value: str | None) -> None:
    if value in (None, ""):
        return
    problem = validate_evidence_url(value)
    if problem:
        raise unprocessable("UNSAFE_URL", problem)


def _validate_due(value: date | None) -> None:
    if value is None:
        return
    if value.year < 2000 or value.year > 2100:
        raise unprocessable("INVALID_DUE_DATE", "due_date is out of range")


# --- create ----------------------------------------------------------------

@router.post("", response_model=TaskOut, status_code=201)
def create_task(payload: TaskCreateIn, current: CurrentUser = Depends(get_current_user)):
    user = current.user
    if not policy.capabilities(user)["can_create_tasks"]:
        raise forbidden("CANNOT_CREATE_TASKS", "Creating tasks is disabled for your role")

    assignee_id = payload.assignee_id
    if policy.can_assign_to_others(user):
        # Honour whatever was sent, including None, which means "nobody yet".
        # This used to rewrite None to the caller's own id, so the "Unassigned"
        # option in the create dialog produced a task assigned to whoever
        # created it, and the board's unassigned bucket could not be reached
        # through the API at all.
        pass
    else:
        if assignee_id is not None and assignee_id != user.id:
            raise forbidden("CANNOT_ASSIGN_OTHERS", "Members may only assign tasks to themselves")
        assignee_id = user.id

    _validate_due(payload.due_date)

    with write_tx() as db:
        assignee = db.get(User, assignee_id) if assignee_id else None
        if assignee_id is not None and (assignee is None or not assignee.is_active):
            raise unprocessable("INVALID_ASSIGNEE", "The assignee must be an active user")
        now = utcnow()
        task = Task(
            title=payload.title.strip(),
            description=payload.description,
            category=payload.category,
            status=TaskStatus.todo.value,
            priority=payload.priority.value,
            progress_percent=0,
            due_date=payload.due_date,
            estimated_minutes=payload.estimated_minutes,
            expected_deliverable=payload.expected_deliverable,
            requires_review=payload.requires_review,
            assignee_id=assignee_id,
            created_by_id=user.id,
            created_at=now,
            updated_at=now,
            version=1,
        )
        db.add(task)
        db.flush()
        audit.record(
            db,
            event_type=EventType.task_created.value,
            entity_type="task",
            entity_id=task.id,
            task_id=task.id,
            actor=user,
            summary=f"Task “{task.title}” created for {assignee.full_name if assignee else 'nobody'}",
            after={
                "title": task.title,
                "status": task.status,
                "priority": task.priority,
                "assignee_id": task.assignee_id,
                "due_date": str(task.due_date) if task.due_date else None,
            },
            created_at=now,
        )
        db.flush()
        db.refresh(task)
        return task_out(user, task, db, now)


# --- list ------------------------------------------------------------------

@router.get("", response_model=TaskListOut)
def list_tasks(
    current: CurrentUser = Depends(get_current_user),
    db: Session = Depends(get_db),
    q: str | None = None,
    status: StatusFilter | None = Query(default=None),
    priority: PriorityFilter | None = Query(default=None),
    assignee_id: int | None = Query(default=None),
    category: str | None = Query(default=None),
    due_from: date | None = Query(default=None),
    due_to: date | None = Query(default=None),
    overdue: bool | None = Query(default=None),
    created_from: date | None = Query(default=None),
    created_to: date | None = Query(default=None),
    completed_from: date | None = Query(default=None),
    completed_to: date | None = Query(default=None),
    include_deleted: bool = Query(default=False),
    deleted_only: bool = Query(
        default=False,
        description="Show only soft-deleted tasks. Requires include_deleted's authority.",
    ),
    mine: bool = Query(default=False),
    sort: SortKey = Query(default="due"),
    order: SortOrder = Query(default="asc"),
    page: int = Query(default=1, ge=1),
    page_size: int = Query(default=25, ge=1, le=100),
):
    user = current.user
    stmt = _base_query(current)

    # "My Tasks" means work assigned to me, plus anything I raised that nobody
    # has taken yet. Work I handed to someone else is deliberately excluded and
    # belongs on Team Tasks — otherwise a lead sees the whole company here.
    if mine:
        stmt = stmt.where(
            or_(
                Task.assignee_id == user.id,
                and_(Task.created_by_id == user.id, Task.assignee_id.is_(None)),
            )
        )

    if include_deleted or deleted_only:
        if not policy.can_view_all_tasks(user):
            raise forbidden("CANNOT_VIEW_DELETED", "Only the CEO and team lead can view deleted tasks")
    else:
        stmt = stmt.where(Task.deleted_at.is_(None))

    # `include_deleted` mixed live and deleted rows together with no way to ask
    # for one or the other, so "show me what we deleted" was not answerable.
    if deleted_only:
        stmt = stmt.where(Task.deleted_at.is_not(None))

    if q and q.strip():
        stmt = stmt.where(Task.title.ilike(f"%{escape_like(q.strip())}%", escape="\\"))
    if status:
        stmt = stmt.where(Task.status == status)
    if priority:
        stmt = stmt.where(Task.priority == priority)
    if category:
        stmt = stmt.where(Task.category == category)
    if assignee_id is not None:
        stmt = stmt.where(Task.assignee_id == assignee_id)
    if due_from:
        stmt = stmt.where(Task.due_date >= due_from)
    if due_to:
        stmt = stmt.where(Task.due_date <= due_to)
    if created_from:
        stmt = stmt.where(Task.created_at >= datetime.combine(created_from, datetime.min.time()))
    if created_to:
        stmt = stmt.where(Task.created_at <= datetime.combine(created_to, datetime.max.time()))
    if completed_from:
        stmt = stmt.where(Task.completed_at >= datetime.combine(completed_from, datetime.min.time()))
    if completed_to:
        stmt = stmt.where(Task.completed_at <= datetime.combine(completed_to, datetime.max.time()))

    if overdue:
        stmt = stmt.where(
            Task.due_date.is_not(None),
            Task.due_date < local_today(),
            Task.status != TaskStatus.completed.value,
            Task.deleted_at.is_(None),
        )

    column = priority_rank() if sort == "priority" else SORT_COLUMNS.get(sort, Task.due_date)
    descending = order == "desc"
    if sort == "priority":
        stmt = stmt.order_by(column.desc() if descending else column.asc(), Task.id.desc())
    else:
        stmt = stmt.order_by(column.is_(None), column.desc() if descending else column.asc(), Task.id.desc())

    total = int(db.scalar(select(func.count()).select_from(stmt.subquery())) or 0)
    rows = db.scalars(stmt.offset((page - 1) * page_size).limit(page_size)).all()

    # One set of four queries for the whole page instead of four per row.
    ctx = TaskContext(db, user, rows)
    return TaskListOut(
        items=[task_out(user, t, db, ctx=ctx) for t in rows],
        total=total,
        page=page,
        page_size=page_size,
    )


@router.get("/board", response_model=TaskBoardOut)
def task_board(
    current: CurrentUser = Depends(get_current_user),
    db: Session = Depends(get_db),
    status: StatusFilter | None = Query(default=None),
    priority: PriorityFilter | None = Query(default=None),
    assignee_id: int | None = Query(default=None),
    category: str | None = Query(default=None),
    overdue: bool | None = Query(default=None),
    q: str | None = Query(default=None),
    include_completed: bool = Query(default=False),
    completed_from: date | None = Query(default=None),
    completed_to: date | None = Query(default=None),
):
    """Every visible task bucketed by the person who owns it.

    The flat list answers "what is open"; this answers "who is carrying what",
    which is what a CEO or lead actually reads. It reuses the caller's normal
    task scope, so a member calling it still only ever sees their own work.

    Every filter the flat list honours is honoured here too. The board used to
    accept priority, assignee, category and overdue and silently ignore them,
    which left the picker looking functional while nothing happened.
    """
    user = current.user
    if not policy.can_view_all_tasks(user):
        raise forbidden("FORBIDDEN", "The team board is for the CEO and team lead")

    stmt = _base_query(current).where(Task.deleted_at.is_(None))
    if status:
        stmt = stmt.where(Task.status == status)
    elif not include_completed:
        stmt = stmt.where(Task.status != TaskStatus.completed.value)
    if priority:
        stmt = stmt.where(Task.priority == priority)
    if assignee_id is not None:
        stmt = stmt.where(Task.assignee_id == assignee_id)
    if category:
        stmt = stmt.where(Task.category == category)
    if overdue:
        stmt = stmt.where(
            Task.due_date.is_not(None),
            Task.due_date < local_today(),
            Task.status != TaskStatus.completed.value,
        )
    if q and q.strip():
        stmt = stmt.where(Task.title.ilike(f"%{escape_like(q.strip())}%", escape="\\"))
    if completed_from:
        stmt = stmt.where(
            Task.completed_at >= datetime.combine(completed_from, datetime.min.time())
        )
    if completed_to:
        stmt = stmt.where(
            Task.completed_at <= datetime.combine(completed_to, datetime.max.time())
        )

    rows = db.scalars(
        stmt.order_by(
            Task.due_date.is_(None), Task.due_date.asc(), priority_rank().asc(), Task.id.asc()
        )
    ).all()
    today = local_today()
    now = utcnow()

    ctx = TaskContext(db, user, rows, now)

    by_person: dict[int | None, list[Task]] = {}
    for task in rows:
        by_person.setdefault(task.assignee_id, []).append(task)

    people: list[PersonTasksOut] = []
    for assignee_id, tasks in by_person.items():
        if assignee_id is None:
            continue
        assignee = db.get(User, assignee_id)
        if assignee is None:
            continue
        open_tasks = [t for t in tasks if t.status != TaskStatus.completed.value]
        people.append(
            PersonTasksOut(
                user=PersonRef(
                    id=assignee.id,
                    full_name=assignee.full_name,
                    display_name=assignee.display_name,
                    avatar_url=assignee.avatar_url,
                    avatar_color=assignee.avatar_color,
                    role=assignee.role,
                ),
                open_count=len(open_tasks),
                overdue_count=sum(1 for t in open_tasks if is_overdue(t, now)),
                blocked_count=sum(1 for t in open_tasks if t.status == TaskStatus.blocked.value),
                tracked_seconds=sum(ctx.tracked.get(t.id, 0) for t in open_tasks),
                tasks=[task_out(user, t, db, now, ctx=ctx) for t in tasks],
            )
        )

    # Busiest first, but never let someone with no open work disappear.
    people.sort(key=lambda p: (-p.open_count, p.user.full_name.lower()))

    unassigned = by_person.get(None, [])
    return TaskBoardOut(
        people=people,
        unassigned_count=len(unassigned),
        unassigned=[task_out(user, t, db, now, ctx=ctx) for t in unassigned],
    )


@router.post("/{task_id}/remind", response_model=ReminderOut)
def send_reminder(
    task_id: int,
    payload: RemindIn,
    current: CurrentUser = Depends(get_current_user),
):
    """A manager nudges the person carrying the task.

    This writes a `task.reminder_sent` audit event, which is what the
    recipient's notification feed reads — so a reminder needs no separate
    message store and can never claim something the history does not show.
    """
    from app.schemas import PersonRef, ReminderOut

    with write_tx() as db:
        task = _load_for_write(current, db, task_id)
        if task.deleted_at is not None:
            raise conflict("TASK_DELETED", "A deleted task cannot be reminded")
        if not policy.can_view_all_tasks(current.user):
            raise forbidden("LEAD_ONLY", "Only a CEO or team lead can send reminders")
        if task.assignee_id is None:
            raise unprocessable("NOT_ASSIGNED", "This task has nobody to remind")

        assignee = db.get(User, task.assignee_id)
        if assignee is None or not assignee.is_active:
            raise unprocessable("INVALID_ASSIGNEE", "The assignee is not an active user")

        now = utcnow()
        message = payload.message.strip() if payload.message else None
        audit.record(
            db,
            event_type=EventType.task_reminder_sent.value,
            entity_type="task",
            entity_id=task.id,
            task_id=task.id,
            actor=current.user,
            summary=(
                f"{current.user.full_name} reminded {assignee.full_name} about “{task.title}”"
                + (f": {message}" if message else "")
            ),
            meta={"message": message, "assignee_id": assignee.id},
            created_at=now,
        )
        return ReminderOut(
            task_id=task.id,
            assignee=PersonRef(
                id=assignee.id,
                full_name=assignee.full_name,
                display_name=assignee.display_name,
                avatar_url=assignee.avatar_url,
                avatar_color=assignee.avatar_color,
                role=assignee.role,
            ),
            sent_by=PersonRef(
                id=current.user.id,
                full_name=current.user.full_name,
                display_name=current.user.display_name,
                avatar_url=current.user.avatar_url,
                avatar_color=current.user.avatar_color,
                role=current.user.role,
            ),
            message=message,
            sent_at=now,
        )


@router.get("/{task_id}/links", response_model=list[LinkOut])
def task_links(
    task_id: int,
    current: CurrentUser = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Links attached to this task, so evidence lives with the work."""
    from app.models import ResourceLink
    from app.serializers import link_out

    task = _load_for_write(current, db, task_id)
    rows = db.scalars(
        select(ResourceLink)
        .where(ResourceLink.task_id == task.id, ResourceLink.deleted_at.is_(None))
        .order_by(ResourceLink.created_at.desc())
    ).all()
    return [link_out(current.user, link) for link in rows]


@router.get("/{task_id}", response_model=TaskOut)
def get_task(task_id: int, current: CurrentUser = Depends(get_current_user), db: Session = Depends(get_db)):
    task = _load_for_write(current, db, task_id)
    return task_out(current.user, task, db)


# --- update ----------------------------------------------------------------

@router.patch("/{task_id}", response_model=TaskOut)
def update_task(
    task_id: int,
    payload: TaskUpdateIn,
    current: CurrentUser = Depends(get_current_user),
):
    user = current.user
    data = payload.model_dump(exclude_unset=True, exclude={"if_version"})
    core_requested = {f: data[f] for f in CORE_FIELDS if f in data}
    progress_requested = {f: data[f] for f in PROGRESS_FIELDS if f in data}

    with write_tx() as db:
        task = _load_for_write(current, db, task_id)

        if payload.if_version is not None and payload.if_version != task.version:
            raise conflict("STALE_VERSION", "This task changed since you loaded it", current_version=task.version)

        if core_requested and not policy.can_edit_core_fields(user, task):
            raise forbidden(
                "FIELD_NOT_ALLOWED",
                "You may not change these fields on this task",
                fields=sorted(core_requested),
            )
        if progress_requested and not policy.can_edit_progress(user, task):
            raise forbidden(
                "FIELD_NOT_ALLOWED",
                "You may not change these fields on this task",
                fields=sorted(progress_requested),
            )
        if "requires_review" in core_requested and not policy.is_lead(user):
            raise forbidden("FIELD_NOT_ALLOWED", "Only a team lead can require review", fields=["requires_review"])

        before = {f: getattr(task, f) for f in list(CORE_FIELDS) + PROGRESS_FIELDS}
        before_serialised = {
            k: (str(v) if isinstance(v, (date, datetime)) else v) for k, v in before.items()
        }

        for field, value in core_requested.items():
            setattr(task, field, value.strip() if isinstance(value, str) else value)
        for field, value in progress_requested.items():
            if field == "evidence_url":
                _validate_evidence(value)
            setattr(task, field, value)

        after_serialised = {
            k: (str(getattr(task, k)) if isinstance(getattr(task, k), (date, datetime)) else getattr(task, k))
            for k in before_serialised
        }

        if before_serialised != after_serialised:
            now = utcnow()
            task.version += 1
            task.updated_at = now
            changed = {
                k: {"from": before_serialised[k], "to": after_serialised[k]}
                for k in before_serialised
                if before_serialised[k] != after_serialised[k]
            }
            audit.record(
                db,
                event_type=EventType.task_updated.value,
                entity_type="task",
                entity_id=task.id,
                task_id=task.id,
                actor=user,
                summary=f"Task “{task.title}” updated",
                before=before_serialised,
                after=after_serialised,
                meta={"changed": changed},
                created_at=now,
            )
            db.flush()
            db.refresh(task)
        return task_out(user, task, db)


# --- status ----------------------------------------------------------------

@router.post("/{task_id}/status", response_model=TaskOut)
def change_status(
    task_id: int,
    payload: StatusChangeIn,
    current: CurrentUser = Depends(get_current_user),
):
    user = current.user
    with write_tx() as db:
        task = _load_for_write(current, db, task_id)
        if task.deleted_at is not None:
            raise conflict("TASK_DELETED", "A deleted task cannot change status")
        if not policy.can_change_status(user, task):
            raise forbidden("STATUS_NOT_ALLOWED", "You may not change this task's status")

        now = utcnow()
        rule = workflow.resolve_transition(
            user,
            task.status,
            payload.status.value,
            requires_review=task.requires_review,
            is_assignee=task.assignee_id == user.id,
            note=payload.note,
            reason=payload.reason,
        )
        reviewer = workflow.is_reviewer(user)
        event_type = workflow.transition_event(task.status, payload.status.value, by_reviewer=reviewer)
        previous_status = task.status

        if rule.closes_timer:
            timelog.close_running_for_task(db, task, now, user, f"status changed to {payload.status.value}")

        task.status = payload.status.value
        if payload.status.value == TaskStatus.blocked.value:
            task.blocked_reason = payload.reason
        elif previous_status == TaskStatus.blocked.value:
            task.blocked_reason = None

        if payload.status.value == TaskStatus.completed.value:
            task.completed_at = now
            task.progress_percent = 100
        elif previous_status == TaskStatus.completed.value:
            task.completed_at = None

        task.version += 1
        task.updated_at = now

        if payload.note:
            db.add(
                _note_row(task.id, user.id, payload.note, now)
            )

        audit.record(
            db,
            event_type=event_type,
            entity_type="task",
            entity_id=task.id,
            task_id=task.id,
            actor=user,
            summary=_status_summary(task, previous_status, payload.status.value, event_type),
            before={"status": previous_status, "completed_at": None if payload.status.value == TaskStatus.completed.value else task.completed_at},
            after={"status": task.status, "completed_at": task.completed_at},
            meta={"note": payload.note, "reason": payload.reason},
            created_at=now,
        )
        db.flush()
        db.refresh(task)
        return task_out(user, task, db)


def _note_row(task_id: int, user_id: int, note: str, now: datetime):
    from app.models import EntryType, Source, WorkSession

    return WorkSession(
        task_id=task_id,
        user_id=user_id,
        entry_type=EntryType.note.value,
        source=Source.manual.value,
        started_at=now,
        ended_at=now,
        duration_seconds=0,
        note=note,
        created_at=now,
    )


def _status_summary(task: Task, previous: str, new: str, event_type: str) -> str:
    label = {
        TaskStatus.todo.value: "To Do",
        TaskStatus.in_progress.value: "In Progress",
        TaskStatus.blocked.value: "Blocked",
        TaskStatus.in_review.value: "In Review",
        TaskStatus.completed.value: "Completed",
    }
    verb = {
        EventType.task_review_requested.value: "submitted for review",
        EventType.task_approved.value: "approved",
        EventType.task_revision_requested.value: "sent back for revision",
        EventType.task_reopened.value: "reopened",
    }.get(event_type, f"moved to {label[new]}")
    return f"“{task.title}” {verb} (from {label[previous]})"


# --- reassign --------------------------------------------------------------

@router.post("/{task_id}/assign", response_model=TaskOut)
def reassign(
    task_id: int,
    payload: ReassignIn,
    current: CurrentUser = Depends(get_current_user),
):
    if not policy.can_reassign(current.user):
        raise forbidden("LEAD_ONLY", "Only a team lead can reassign tasks")
    with write_tx() as db:
        task = _load_for_write(current, db, task_id)
        if task.deleted_at is not None:
            raise conflict("TASK_DELETED", "A deleted task cannot be reassigned")
        successor = db.get(User, payload.assignee_id)
        if successor is None or not successor.is_active:
            raise unprocessable("INVALID_ASSIGNEE", "The assignee must be an active user")
        if successor.id == task.assignee_id:
            raise conflict("ALREADY_ASSIGNED", "That user already owns this task")

        now = utcnow()
        previous_id = task.assignee_id
        timelog.close_running_for_task(db, task, now, current.user, "task reassigned")
        task.assignee_id = successor.id
        task.version += 1
        task.updated_at = now
        audit.record(
            db,
            event_type=EventType.task_assigned.value,
            entity_type="task",
            entity_id=task.id,
            task_id=task.id,
            actor=current.user,
            summary=f"“{task.title}” assigned to {successor.full_name}",
            before={"assignee_id": previous_id},
            after={"assignee_id": successor.id},
            created_at=now,
        )
        db.flush()
        db.refresh(task)
        return task_out(current.user, task, db)


# --- delete / restore ------------------------------------------------------

@router.delete("/{task_id}", response_model=TaskOut)
def delete_task(task_id: int, current: CurrentUser = Depends(get_current_user)):
    user = current.user
    with write_tx() as db:
        task = _load_for_write(current, db, task_id)
        if task.deleted_at is not None:
            raise conflict("ALREADY_DELETED", "That task is already deleted")
        if not policy.can_delete_task(user, task):
            raise forbidden("CANNOT_DELETE", "You may not delete this task")

        now = utcnow()
        timelog.close_running_for_task(db, task, now, user, "task deleted")
        task.deleted_at = now
        task.deleted_by_id = user.id
        task.updated_at = now
        task.version += 1
        audit.record(
            db,
            event_type=EventType.task_deleted.value,
            entity_type="task",
            entity_id=task.id,
            task_id=task.id,
            actor=user,
            summary=f"Task “{task.title}” deleted",
            before={"deleted_at": None},
            after={"deleted_at": now},
            created_at=now,
        )
        db.flush()
        db.refresh(task)
        return task_out(user, task, db)


@router.post("/{task_id}/restore", response_model=TaskOut)
def restore_task(task_id: int, current: CurrentUser = Depends(get_current_user)):
    if not policy.can_restore_task(current.user):
        raise forbidden("LEAD_ONLY", "Only a team lead can restore tasks")
    with write_tx() as db:
        task = _load_for_write(current, db, task_id)
        if task.deleted_at is None:
            raise conflict("NOT_DELETED", "That task is not deleted")
        now = utcnow()
        previous_deleted_at = task.deleted_at
        task.deleted_at = None
        task.deleted_by_id = None
        task.updated_at = now
        task.version += 1
        audit.record(
            db,
            event_type=EventType.task_restored.value,
            entity_type="task",
            entity_id=task.id,
            task_id=task.id,
            actor=current.user,
            summary=f"Task “{task.title}” restored",
            before={"deleted_at": previous_deleted_at},
            after={"deleted_at": None},
            created_at=now,
        )
        db.flush()
        db.refresh(task)
        return task_out(current.user, task, db)