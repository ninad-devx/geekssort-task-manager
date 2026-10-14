"""Authorization is enforced only here and in router dependencies (rule 4).

Object-level denial returns 404, never 403, so IDs cannot be enumerated (D-10).
The frontend renders from server-supplied capabilities and allowed_actions.

What a role may do is not decided here — it comes from `app/permissions.py`, so an
admin can reshape a role's powers without a code change. This module only
translates a resolved permission set into concrete answers about a concrete user,
task, folder or link.
"""

from __future__ import annotations

from app.models import Task, TaskStatus, User, Visibility


def permissions_for(user: User) -> set[str]:
    """The caller's resolved permission set.

    `hydrate` attaches it during authentication; without it we fall back to the
    role defaults so non-request code paths (CLI, tests) stay correct.
    """
    resolved = getattr(user, "_resolved_permissions", None)
    if resolved is None:
        from app.permissions import defaults_for

        return defaults_for(user.role)
    return resolved


def has(user: User, key: str) -> bool:
    return key in permissions_for(user)


def is_manager(user: User) -> bool:
    """Sees every task and the team/executive dashboards."""
    return has(user, "view_team_tasks")


def is_lead(user: User) -> bool:
    """Holds broad control over tasks. Kept for call sites that mean 'oversight'."""
    return has(user, "edit_any_task")


def can_view_all_tasks(user: User) -> bool:
    return is_manager(user)


def is_reviewer(user: User) -> bool:
    return bool(user.can_review) or has(user, "review_work")


def can_assign_to_others(user: User) -> bool:
    return has(user, "assign_to_others")


def can_reassign(user: User) -> bool:
    return has(user, "reassign_tasks")


def capabilities(user: User) -> dict[str, bool]:
    return {
        "can_create_tasks": has(user, "create_tasks"),
        "can_view_team": is_manager(user),
        "can_view_executive_dashboard": is_manager(user),
        "can_view_lead_dashboard": is_manager(user),
        "can_manage_users": bool(user.is_admin),
        "can_review": is_reviewer(user),
        "can_create_folders": has(user, "create_folders"),
        "can_add_links": has(user, "add_links"),
        "can_edit_time": has(user, "edit_time"),
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
        from app.errors import not_found

        raise not_found("TASK_NOT_FOUND", "Task not found")
    return task


def is_self_created_by_member(user: User, task: Task) -> bool:
    return (
        not is_manager(user)
        and task.created_by_id == user.id
        and task.assignee_id == user.id
    )


def can_edit_core_fields(user: User, task: Task) -> bool:
    return has(user, "edit_any_task") or is_self_created_by_member(user, task)


def can_edit_progress(user: User, task: Task) -> bool:
    return has(user, "edit_any_task") or task.assignee_id == user.id


def can_change_status(user: User, task: Task) -> bool:
    if has(user, "change_status_any"):
        return True
    if task.assignee_id == user.id and has(user, "change_status_assigned"):
        return True
    if has(user, "review_only_status"):
        return bool(user.can_review) and task.status == TaskStatus.in_review.value
    return False


def can_delete_task(user: User, task: Task) -> bool:
    if has(user, "delete_any_task"):
        return True
    if task.assignee_id == user.id and has(user, "delete_assigned_task"):
        return True
    return is_self_created_by_member(user, task)


def can_restore_task(user: User) -> bool:
    return has(user, "restore_tasks")


def can_track_time(user: User, task: Task) -> bool:
    return has(user, "track_time") and task.assignee_id == user.id


def can_manage_folder(user: User) -> bool:
    return has(user, "manage_folders")


def can_create_folder(user: User) -> bool:
    return has(user, "create_folders")


def can_edit_link(user: User, link) -> bool:
    if has(user, "edit_any_link"):
        return True
    if not has(user, "add_links"):
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