"""Role powers are data, not code.

Every authorization decision in `app/policy.py` reads from the permission set of
the caller's role. A role with no row in `role_permissions` uses
`DEFAULT_ROLE_PERMISSIONS` below, which reproduces the behaviour the P0 spec
hard-coded. An admin can override any role from the Permissions screen; the
override is stored, audited, and resolved fresh on every request.
"""

from __future__ import annotations

import json

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.config import settings
from app.models import Role, RolePermission

# (key, human label). Order is the display order in the admin UI.
PERMISSION_KEYS: list[tuple[str, str]] = [
    ("view_team_tasks", "See everyone's tasks and the team / executive dashboards"),
    ("create_tasks", "Create tasks"),
    ("assign_to_others", "Choose any assignee when creating a task"),
    ("reassign_tasks", "Reassign an existing task to another person"),
    ("edit_any_task", "Edit any visible task, including its core fields"),
    ("change_status_any", "Change the status of any task"),
    ("change_status_assigned", "Change the status of tasks assigned to them"),
    ("review_only_status", "Only act on a task while it sits in review"),
    ("review_work", "Review, approve or send back submitted work"),
    ("delete_any_task", "Delete any task"),
    ("delete_assigned_task", "Delete tasks assigned to them"),
    ("restore_tasks", "Restore deleted tasks"),
    ("track_time", "Run the timer on tasks assigned to them"),
    ("edit_time", "Edit or delete their own logged time"),
    ("manage_folders", "Rename, move and delete workspace folders"),
    ("create_folders", "Create workspace folders"),
    ("add_links", "Add links to the workspace"),
    ("edit_any_link", "Edit and delete links added by others"),
]

PERMISSION_NAMES = {key for key, _ in PERMISSION_KEYS}


def _defaults(**granted: bool) -> set[str]:
    return {key for key, on in granted.items() if on}


DEFAULT_ROLE_PERMISSIONS: dict[str, set[str]] = {
    Role.member.value: _defaults(
        create_tasks=settings.MEMBER_CAN_CREATE_TASKS,
        change_status_assigned=True,
        delete_assigned_task=settings.MEMBER_CAN_DELETE_ASSIGNED_TASKS,
        track_time=True,
        edit_time=settings.MEMBER_CAN_EDIT_TIME,
        create_folders=settings.MEMBER_CAN_CREATE_FOLDERS,
        add_links=settings.MEMBER_CAN_ADD_LINKS,
    ),
    Role.team_lead.value: _defaults(
        view_team_tasks=True,
        create_tasks=settings.MEMBER_CAN_CREATE_TASKS,
        assign_to_others=True,
        reassign_tasks=True,
        edit_any_task=True,
        change_status_any=True,
        change_status_assigned=True,
        review_work=True,
        delete_any_task=True,
        restore_tasks=True,
        track_time=True,
        edit_time=True,
        manage_folders=True,
        create_folders=True,
        add_links=True,
        edit_any_link=True,
    ),
    Role.ceo.value: _defaults(
        view_team_tasks=True,
        review_only_status=True,
        track_time=True,
        edit_time=True,
    ),
}


def defaults_for(role: str) -> set[str]:
    return set(DEFAULT_ROLE_PERMISSIONS.get(role, DEFAULT_ROLE_PERMISSIONS[Role.member.value]))


def effective_matrix(db: Session) -> dict[str, set[str]]:
    """Every known role mapped to the permissions it currently resolves to."""
    overrides = {
        row.role: _decode(row.permissions_json)
        for row in db.scalars(select(RolePermission)).all()
    }
    return {
        role.value: set(overrides.get(role.value) or defaults_for(role.value))
        for role in Role
    }


def _decode(raw: str | None) -> set[str]:
    if not raw:
        return set()
    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError:
        return set()
    if not isinstance(parsed, list):
        return set()
    return {p for p in parsed if isinstance(p, str) and p in PERMISSION_NAMES}


def encode(permissions) -> str:
    return json.dumps(sorted({p for p in permissions if p in PERMISSION_NAMES}))


def role_entity_id(role: str) -> int:
    """A stable integer for a role.

    `audit_events.entity_id` is NOT NULL and every other audited entity is a
    table row. Roles are a fixed enum with no row of their own, so they get a
    stable 1-based ordinal and the role name travels in the event's `meta`.
    """
    return [r.value for r in Role].index(role) + 1


def resolve(db: Session, role: str) -> set[str]:
    row = db.get(RolePermission, role)
    if row is None:
        return defaults_for(role)
    return _decode(row.permissions_json)