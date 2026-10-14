"""Authorization is enforced only here and in router dependencies (rule 4).

Object-level denial returns 404, never 403, so IDs cannot be enumerated (D-10).
The frontend renders from server-supplied capabilities and allowed_actions.
"""

from __future__ import annotations

from app.config import settings
from app.errors import forbidden, not_found
from app.models import Role, Task, TaskStatus, User, Visibility


def is_ceo(user: User) -> bool:
    return user.role == Role.ceo.value


def is_lead(user: User) -> bool:
    return user.role == Role.team_lead.value


def is_manager(user: User) -> bool:
    """CEO or team lead: the oversight roles."""
    return is_ceo(user) or is_lead(user)


def can_view_all_tasks(user: User) -> bool:
    return is_manager(user)


def is_reviewer(user: User) -> bool:
    return bool(user.can_review) or user.role == Role.team_lead.value


def capabilities(user: User) -> dict[str, bool]:
    return {
        # 7.2: a CEO cannot create or edit tasks
        "can_create_tasks": (not is_ceo(user)) and settings.MEMBER_CAN_CREATE_TASKS,
        "can_view_team": is_manager(user),
        "can_view_executive_dashboard": is_manager(user),
        "can_view_lead_dashboard": is_manager(user),
        "can_manage_users": bool(user.is_admin),
        "can_review": bool(user.can_review),
        "can_create_folders": is_lead(user) or settings.MEMBER_CAN_CREATE_FOLDERS,
        "can_add_links": (not is_ceo(user)) and settings.MEMBER_CAN_ADD_LINKS,
        "can_edit_time": settings.MEMBER_CAN_EDIT_TIME,
    }


# --- task visibility -------------------------------------------------------

def task_query_scope(user: User):
    """Return a SQLAlchemy filter enforcing what the caller may see."""
    from sqlalchemy import or_

    if is_manager(user):
        return None
    return or_(Task.assignee_id == user.id, Task.created_by_id == user.id)


def can_see_task(user: User, task: Task) -> bool:
    if task.deleted_at is not None:
        return is_manager(user)
    return is_manager(user) or task.assignee_id == user.id or task.created_by_id == user.id


def get_visible_task(user: User, task_id: int, db) -> Task:
    task = db.get(Task, task_id)
    if task is None or not can_see_task(user, task):
        raise not_found("TASK_NOT_FOUND", "Task not found")
    return task


def is_self_created_by_member(user: User, task: Task) -> bool:
    return (
        not is_manager(user)
        and task.created_by_id == user.id
        and task.assignee_id == user.id
    )


def can_edit_core_fields(user: User, task: Task) -> bool:
    if is_lead(user):
        return True
    if is_ceo(user):
        return False
    return is_self_created_by_member(user, task)


def can_edit_progress(user: User, task: Task) -> bool:
    """Team lead on any task; anyone on a task assigned to them (7.2)."""
    if is_lead(user):
        return True
    return task.assignee_id == user.id


def can_change_status(user: User, task: Task) -> bool:
    """A CEO may only use the two review transitions (10.2)."""
    if is_ceo(user):
        return bool(user.can_review) and task.status == TaskStatus.in_review.value
    return is_lead(user) or task.assignee_id == user.id


def can_delete_task(user: User, task: Task) -> bool:
    if is_lead(user):
        return True
    if is_ceo(user):
        return False
    if is_self_created_by_member(user, task):
        return True
    return settings.MEMBER_CAN_DELETE_ASSIGNED_TASKS and task.assignee_id == user.id


def can_restore_task(user: User) -> bool:
    return is_lead(user)


def can_track_time(user: User, task: Task) -> bool:
    return task.assignee_id == user.id


def can_manage_folder(user: User) -> bool:
    return is_lead(user)


def can_edit_link(user: User, link) -> bool:
    if is_lead(user):
        return True
    if is_ceo(user):
        return False
    return link.created_by_id == user.id


def can_view_folder(user: User, folder) -> bool:
    if folder.visibility == Visibility.management.value and not is_manager(user):
        return False
    return True


def folder_query_scope(user: User):
    """Members see only visibility='all' folders."""
    from app.models import Folder

    if is_manager(user):
        return None
    return Folder.visibility == Visibility.all.value