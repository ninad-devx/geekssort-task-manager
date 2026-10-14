from __future__ import annotations

from datetime import date, datetime
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator

from app.models import EntryType, Priority, Role, TaskStatus, Visibility

Camel = ConfigDict(populate_by_name=True)


# --- auth ------------------------------------------------------------------

class LoginIn(BaseModel):
    email: str
    password: str


class ChangePasswordIn(BaseModel):
    current_password: str
    new_password: str


class UserOut(BaseModel):
    id: int
    email: str
    full_name: str
    display_name: str | None = None
    avatar_url: str | None = None
    avatar_color: str | None = None
    role: str
    is_admin: bool
    can_review: bool
    is_active: bool
    must_change_password: bool
    created_at: datetime


class SessionInfoOut(BaseModel):
    user: UserOut
    capabilities: dict[str, bool]
    server_time: datetime
    app_timezone: str


class DirectoryEntry(BaseModel):
    id: int
    full_name: str
    display_name: str | None = None
    avatar_url: str | None = None
    avatar_color: str | None = None
    role: str
    is_active: bool


# --- users -----------------------------------------------------------------

class UserCreateIn(BaseModel):
    email: str = Field(min_length=3, max_length=320)
    full_name: str = Field(min_length=1, max_length=200)
    role: Role = Role.member
    is_admin: bool = False
    can_review: bool | None = None
    password: str | None = Field(default=None, max_length=128)


class UserUpdateIn(BaseModel):
    full_name: str | None = Field(default=None, min_length=1, max_length=200)
    display_name: str | None = Field(default=None, max_length=200)
    avatar_url: str | None = Field(default=None, max_length=2048)
    avatar_color: str | None = Field(default=None, max_length=7)
    role: Role | None = None
    is_admin: bool | None = None
    can_review: bool | None = None
    is_active: bool | None = None


class PasswordResetIn(BaseModel):
    new_password: str | None = Field(default=None, max_length=128)


class DeactivateIn(BaseModel):
    reassign_to_user_id: int | None = None


class UserCreatedOut(UserOut):
    temporary_password: str | None = None


# --- role permissions -------------------------------------------------------

class PermissionInfo(BaseModel):
    key: str
    label: str


class RolePermissionsOut(BaseModel):
    role: Role
    permissions: list[str]
    defaults: list[str]
    is_default: bool
    updated_at: datetime | None = None


class PermissionsMatrixOut(BaseModel):
    permissions: list[PermissionInfo]
    roles: list[RolePermissionsOut]


class RolePermissionsIn(BaseModel):
    permissions: list[str]


# --- time reporting ---------------------------------------------------------

class TimeTaskTotal(BaseModel):
    task_id: int
    task_title: str
    task_status: TaskStatus
    seconds: int
    entry_count: int


class TimePersonTotal(BaseModel):
    user: TaskActor
    seconds: int
    entry_count: int
    tasks: list[TimeTaskTotal]


class TimeSummaryOut(BaseModel):
    scope: str
    days: int
    total_seconds: int
    people: list[TimePersonTotal]


# --- team tasks grouped by person -------------------------------------------

class PersonRef(BaseModel):
    id: int
    full_name: str
    display_name: str | None = None
    avatar_url: str | None = None
    avatar_color: str | None = None
    role: str


class PersonTasksOut(BaseModel):
    user: PersonRef
    open_count: int
    overdue_count: int
    blocked_count: int
    tracked_seconds: int
    tasks: list[TaskOut]


class TaskBoardOut(BaseModel):
    people: list[PersonTasksOut]
    unassigned_count: int
    unassigned: list[TaskOut]


# --- notifications ----------------------------------------------------------

class NotificationOut(BaseModel):
    id: int
    task_id: int
    task_title: str
    task_status: TaskStatus
    actor_name: str
    actor_id: int | None
    created_at: datetime
    is_new: bool
    is_reminder: bool = False
    message: str | None = None


class NotificationListOut(BaseModel):
    items: list[NotificationOut]
    unread: int
    server_time: datetime


# --- tasks -----------------------------------------------------------------

CORE_FIELDS = [
    "title",
    "description",
    "category",
    "priority",
    "due_date",
    "estimated_minutes",
    "expected_deliverable",
    "requires_review",
]
PROGRESS_FIELDS = ["progress_percent", "evidence_url"]


class TaskCreateIn(BaseModel):
    title: str = Field(min_length=1, max_length=200)
    description: str | None = Field(default=None, max_length=5000)
    category: str | None = Field(default=None, max_length=64)
    priority: Priority = Priority.medium
    due_date: date | None = None
    estimated_minutes: int | None = Field(default=None, ge=1, le=100000)
    expected_deliverable: str | None = Field(default=None, max_length=500)
    requires_review: bool = False
    assignee_id: int | None = None


class TaskUpdateIn(BaseModel):
    title: str | None = Field(default=None, min_length=1, max_length=200)
    description: str | None = Field(default=None, max_length=5000)
    category: str | None = Field(default=None, max_length=64)
    priority: Priority | None = None
    due_date: date | None = None
    estimated_minutes: int | None = Field(default=None, ge=1, le=100000)
    expected_deliverable: str | None = Field(default=None, max_length=500)
    requires_review: bool | None = None
    progress_percent: int | None = Field(default=None, ge=0, le=100)
    evidence_url: str | None = Field(default=None, max_length=2048)
    if_version: int | None = None


class StatusChangeIn(BaseModel):
    status: TaskStatus
    note: str | None = Field(default=None, max_length=2000)
    reason: str | None = Field(default=None, max_length=2000)


class ReassignIn(BaseModel):
    assignee_id: int


class CategoryOut(BaseModel):
    slug: str
    label: str
    is_active: bool
    sort_order: int
    task_count: int = 0


class CategoryIn(BaseModel):
    label: str | None = Field(default=None, max_length=64)
    sort_order: int | None = None
    is_active: bool | None = None


class RemindIn(BaseModel):
    message: str | None = Field(default=None, max_length=500)


class ReminderOut(BaseModel):
    task_id: int
    assignee: PersonRef | None
    sent_by: PersonRef
    message: str | None
    sent_at: datetime

class TaskActor(BaseModel):
    id: int
    full_name: str
    role: str


class RunningTimer(BaseModel):
    log_id: int
    task_id: int
    task_title: str
    started_at: datetime
    elapsed_seconds: int
    is_stale: bool


class TaskOut(BaseModel):
    id: int
    title: str
    description: str | None
    category: str | None
    status: str
    priority: str
    progress_percent: int
    due_date: date | None
    estimated_minutes: int | None
    expected_deliverable: str | None
    evidence_url: str | None
    requires_review: bool
    blocked_reason: str | None
    assignee_id: int | None
    assignee: TaskActor | None
    created_by_id: int | None
    created_by: TaskActor | None
    completed_at: datetime | None
    deleted_at: datetime | None
    created_at: datetime
    updated_at: datetime
    version: int
    is_overdue: bool
    tracked_seconds: int
    running: RunningTimer | None = None
    allowed_actions: list[str] = Field(default_factory=list)
    log_count: int = 0


class TaskListOut(BaseModel):
    items: list[TaskOut]
    total: int
    page: int
    page_size: int


# --- logs ------------------------------------------------------------------

class ManualEntryIn(BaseModel):
    entry_type: Literal["work_session", "note"] = EntryType.work_session.value
    started_at: datetime
    ended_at: datetime | None = None
    duration_minutes: int | None = Field(default=None, ge=1, le=24 * 60)
    note: str | None = Field(default=None, max_length=2000)
    progress_percent: int | None = Field(default=None, ge=0, le=100)
    evidence_url: str | None = Field(default=None, max_length=2048)


class LogEditIn(BaseModel):
    started_at: datetime | None = None
    ended_at: datetime | None = None
    note: str | None = Field(default=None, max_length=2000)
    progress_percent: int | None = Field(default=None, ge=0, le=100)
    evidence_url: str | None = Field(default=None, max_length=2048)
    edit_reason: str | None = Field(default=None, max_length=200)
    if_ended_at_unchanged: bool = True


class PauseIn(BaseModel):
    log_id: int | None = None
    ended_at: datetime | None = None
    note: str | None = Field(default=None, max_length=2000)
    progress_percent: int | None = Field(default=None, ge=0, le=100)
    evidence_url: str | None = Field(default=None, max_length=2048)


class LogOut(BaseModel):
    id: int
    task_id: int
    user_id: int
    user: TaskActor | None
    entry_type: str
    source: str
    started_at: datetime
    ended_at: datetime | None
    duration_seconds: int | None
    note: str | None
    progress_percent: int | None
    evidence_url: str | None
    edit_count: int
    edited_at: datetime | None
    deleted_at: datetime | None
    created_at: datetime
    allowed_actions: list[str] = Field(default_factory=list)


class PauseOut(BaseModel):
    log: LogOut
    task: TaskOut
    adjusted: bool = False


class StartOut(BaseModel):
    log: LogOut
    task: TaskOut
    paused_previous: LogOut | None = None


# --- audit -----------------------------------------------------------------

class AuditEventOut(BaseModel):
    id: int
    request_id: str
    event_type: str
    actor_id: int | None
    actor_name: str
    entity_type: str
    entity_id: int | None = None
    task_id: int | None
    summary: str
    before: dict[str, Any] | None
    after: dict[str, Any] | None
    meta: dict[str, Any] | None
    created_at: datetime


class AuditListOut(BaseModel):
    items: list[AuditEventOut]
    total: int
    page: int
    page_size: int


# --- workspace -------------------------------------------------------------

class FolderCreateIn(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    description: str | None = Field(default=None, max_length=2000)
    parent_id: int | None = None
    visibility: Visibility = Visibility.all


class FolderUpdateIn(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=200)
    description: str | None = Field(default=None, max_length=2000)
    visibility: Visibility | None = None


class FolderMoveIn(BaseModel):
    parent_id: int | None = None


class FolderOut(BaseModel):
    id: int
    name: str
    description: str | None
    parent_id: int | None
    visibility: str
    depth: int
    created_at: datetime
    link_count: int = 0
    child_count: int = 0
    allowed_actions: list[str] = Field(default_factory=list)


class LinkCreateIn(BaseModel):
    folder_id: int | None = None
    task_id: int | None = None
    title: str = Field(min_length=1, max_length=200)
    url: str = Field(min_length=1, max_length=2048)
    description: str | None = Field(default=None, max_length=1000)
    tags: list[str] = Field(default_factory=list, max_length=10)

    @field_validator("tags")
    @classmethod
    def _tags(cls, v: list[str]) -> list[str]:
        return [t for t in v if t.strip()][:10]


class LinkUpdateIn(BaseModel):
    folder_id: int | None = None
    task_id: int | None = None
    title: str | None = Field(default=None, min_length=1, max_length=200)
    url: str | None = Field(default=None, min_length=1, max_length=2048)
    description: str | None = Field(default=None, max_length=1000)
    tags: list[str] | None = Field(default=None, max_length=10)


class LinkOut(BaseModel):
    id: int
    folder_id: int | None
    folder_name: str | None
    folder_visibility: str | None
    task_id: int | None = None
    title: str
    url: str
    description: str | None
    tags: list[str]
    created_by_id: int | None
    created_by: PersonRef | None = None
    created_at: datetime
    updated_at: datetime
    allowed_actions: list[str] = Field(default_factory=list)