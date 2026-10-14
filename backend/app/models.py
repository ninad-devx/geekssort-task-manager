from __future__ import annotations

import enum
from datetime import date, datetime, timezone

from sqlalchemy import (
    Boolean,
    CheckConstraint,
    Date,
    DateTime,
    Float,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    UniqueConstraint,
    func,
    text,
)
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, relationship


def utcnow() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)


class Base(DeclarativeBase):
    pass


class Role(str, enum.Enum):
    ceo = "ceo"
    team_lead = "team_lead"
    member = "member"


class TaskStatus(str, enum.Enum):
    todo = "todo"
    in_progress = "in_progress"
    blocked = "blocked"
    in_review = "in_review"
    completed = "completed"


class Priority(str, enum.Enum):
    low = "low"
    medium = "medium"
    high = "high"
    urgent = "urgent"


class Visibility(str, enum.Enum):
    all = "all"
    management = "management"


class EntryType(str, enum.Enum):
    work_session = "work_session"
    note = "note"


class Source(str, enum.Enum):
    timer = "timer"
    manual = "manual"


class EventType(str, enum.Enum):
    user_created = "user.created"
    user_updated = "user.updated"
    user_deactivated = "user.deactivated"
    user_reactivated = "user.reactivated"
    password_changed = "user.password_changed"
    password_reset = "user.password_reset"
    task_created = "task.created"
    task_updated = "task.updated"
    task_assigned = "task.assigned"
    task_deleted = "task.deleted"
    task_restored = "task.restored"
    task_status_changed = "task.status_changed"
    task_review_requested = "task.review_requested"
    task_reminder_sent = "task.reminder_sent"
    task_approved = "task.approved"
    task_revision_requested = "task.revision_requested"
    task_reopened = "task.reopened"
    timer_started = "timer.started"
    timer_paused = "timer.paused"
    log_manual_added = "log.manual_added"
    log_note_added = "log.note_added"
    log_edited = "log.edited"
    log_deleted = "log.deleted"
    folder_created = "folder.created"
    folder_updated = "folder.updated"
    folder_moved = "folder.moved"
    folder_deleted = "folder.deleted"
    link_created = "link.created"
    link_updated = "link.updated"
    link_deleted = "link.deleted"
    role_permissions_updated = "role.permissions_updated"
    category_created = "category.created"
    category_updated = "category.updated"


# --- users -----------------------------------------------------------------

class User(Base):
    __tablename__ = "users"

    id: Mapped[int] = mapped_column(primary_key=True)
    email: Mapped[str] = mapped_column(String(320), unique=True, index=True)
    full_name: Mapped[str] = mapped_column(String(200))
    password_hash: Mapped[str] = mapped_column(String(255))
    role: Mapped[str] = mapped_column(String(20), default=Role.member.value, index=True)
    display_name: Mapped[str | None] = mapped_column(String(200), nullable=True)
    avatar_url: Mapped[str | None] = mapped_column(String(2048), nullable=True)
    avatar_color: Mapped[str | None] = mapped_column(String(7), nullable=True)
    is_admin: Mapped[bool] = mapped_column(Boolean, default=False)
    can_review: Mapped[bool] = mapped_column(Boolean, default=False)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True, index=True)
    must_change_password: Mapped[bool] = mapped_column(Boolean, default=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, onupdate=utcnow)

    sessions: Mapped[list["SessionRow"]] = relationship(back_populates="user")


class Category(Base):
    """A task category an admin can rename or retire without breaking history.

    Tasks store the slug, so a rename is safe; `is_active=false` hides a
    category from the pickers while leaving existing tasks readable. The row
    has an integer id because `audit_events.entity_id` is an integer column
    and every audited entity needs a numeric identity.
    """

    __tablename__ = "categories"

    id: Mapped[int] = mapped_column(primary_key=True)
    slug: Mapped[str] = mapped_column(String(64), unique=True, index=True)
    label: Mapped[str] = mapped_column(String(64))
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)
    sort_order: Mapped[int] = mapped_column(Integer, default=0)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, onupdate=utcnow)


class RolePermission(Base):
    """An admin's override of a role's default powers. Absent row means defaults."""

    __tablename__ = "role_permissions"

    role: Mapped[str] = mapped_column(String(20), primary_key=True)
    permissions_json: Mapped[str] = mapped_column(Text, default="[]")
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, onupdate=utcnow)
    updated_by_id: Mapped[int | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )


class SessionRow(Base):
    __tablename__ = "sessions"

    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    token_hash: Mapped[str] = mapped_column(String(64), unique=True, index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)
    last_seen_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)
    expires_at: Mapped[datetime] = mapped_column(DateTime, index=True)
    absolute_expires_at: Mapped[datetime] = mapped_column(DateTime)
    ip: Mapped[str | None] = mapped_column(String(64), nullable=True)
    user_agent: Mapped[str | None] = mapped_column(String(255), nullable=True)

    user: Mapped[User] = relationship(back_populates="sessions")


# --- tasks -----------------------------------------------------------------

class Task(Base):
    __tablename__ = "tasks"

    id: Mapped[int] = mapped_column(primary_key=True)
    title: Mapped[str] = mapped_column(String(200))
    description: Mapped[str | None] = mapped_column(Text, nullable=True)
    category: Mapped[str | None] = mapped_column(String(64), nullable=True, index=True)
    status: Mapped[str] = mapped_column(String(20), default=TaskStatus.todo.value, index=True)
    priority: Mapped[str] = mapped_column(String(20), default=Priority.medium.value, index=True)
    progress_percent: Mapped[int] = mapped_column(Integer, default=0)
    due_date: Mapped[date | None] = mapped_column(Date, nullable=True, index=True)
    estimated_minutes: Mapped[int | None] = mapped_column(Integer, nullable=True)
    expected_deliverable: Mapped[str | None] = mapped_column(String(500), nullable=True)
    evidence_url: Mapped[str | None] = mapped_column(String(2048), nullable=True)
    requires_review: Mapped[bool] = mapped_column(Boolean, default=False)
    blocked_reason: Mapped[str | None] = mapped_column(Text, nullable=True)

    assignee_id: Mapped[int | None] = mapped_column(ForeignKey("users.id"), index=True)
    created_by_id: Mapped[int | None] = mapped_column(ForeignKey("users.id"), index=True)
    deleted_by_id: Mapped[int | None] = mapped_column(ForeignKey("users.id"), nullable=True)

    completed_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    deleted_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True, index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, onupdate=utcnow)
    version: Mapped[int] = mapped_column(Integer, default=1)

    assignee: Mapped["User | None"] = relationship(foreign_keys=[assignee_id])
    creator: Mapped["User | None"] = relationship(foreign_keys=[created_by_id])


Index("ix_tasks_status_deleted", Task.status, Task.deleted_at)

TASK_CATEGORIES = [
    "content",
    "social_media",
    "campaign",
    "leads_outreach",
    "events",
    "competitor_research",
    "company_resources",
    "other",
]


# --- time tracking ---------------------------------------------------------

class WorkSession(Base):
    __tablename__ = "task_logs"

    id: Mapped[int] = mapped_column(primary_key=True)
    task_id: Mapped[int] = mapped_column(ForeignKey("tasks.id"), index=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id"), index=True)

    entry_type: Mapped[str] = mapped_column(String(20), default=EntryType.work_session.value)
    source: Mapped[str] = mapped_column(String(20), default=Source.timer.value)

    started_at: Mapped[datetime] = mapped_column(DateTime, index=True)
    ended_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True, index=True)
    duration_seconds: Mapped[int | None] = mapped_column(Integer, nullable=True)

    note: Mapped[str | None] = mapped_column(Text, nullable=True)
    progress_percent: Mapped[int | None] = mapped_column(Integer, nullable=True)
    evidence_url: Mapped[str | None] = mapped_column(String(2048), nullable=True)

    edited_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    edit_count: Mapped[int] = mapped_column(Integer, default=0)

    deleted_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True, index=True)
    deleted_by_id: Mapped[int | None] = mapped_column(ForeignKey("users.id"), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)

    task: Mapped[Task] = relationship()
    user: Mapped["User"] = relationship(foreign_keys=[user_id])
    deleted_by: Mapped["User | None"] = relationship(foreign_keys=[deleted_by_id])

    __table_args__ = (
        CheckConstraint("ended_at IS NULL OR ended_at >= started_at", name="ck_log_interval"),
        # A person may run several timers at once, but never two on the same
        # task. Previously this was one running timer per person; that made
        # switching tasks destroy the previous session, which is exactly the
        # friction multi-task work hit.
        Index(
            "uq_running_session_per_user_task",
            "user_id",
            "task_id",
            unique=True,
            sqlite_where=text("ended_at IS NULL"),
        ),
    )


# --- audit -----------------------------------------------------------------

class AuditEvent(Base):
    __tablename__ = "audit_events"

    id: Mapped[int] = mapped_column(primary_key=True)
    event_type: Mapped[str] = mapped_column(String(50), index=True)
    request_id: Mapped[str] = mapped_column(String(64), index=True)
    actor_id: Mapped[int | None] = mapped_column(ForeignKey("users.id"), nullable=True, index=True)
    actor_name: Mapped[str] = mapped_column(String(200), default="system")

    entity_type: Mapped[str] = mapped_column(String(30), index=True)
    entity_id: Mapped[int] = mapped_column(Integer, index=True)
    task_id: Mapped[int | None] = mapped_column(ForeignKey("tasks.id"), nullable=True, index=True)

    summary: Mapped[str] = mapped_column(Text)
    before_json: Mapped[str | None] = mapped_column(Text, nullable=True)
    after_json: Mapped[str | None] = mapped_column(Text, nullable=True)
    meta_json: Mapped[str | None] = mapped_column(Text, nullable=True)

    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, index=True)

    actor: Mapped["User | None"] = relationship()
    task: Mapped["Task | None"] = relationship()


# --- workspace -------------------------------------------------------------

class Folder(Base):
    __tablename__ = "workspace_folders"

    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(200))
    description: Mapped[str | None] = mapped_column(Text, nullable=True)
    parent_id: Mapped[int | None] = mapped_column(ForeignKey("workspace_folders.id"), nullable=True, index=True)
    visibility: Mapped[str] = mapped_column(String(20), default=Visibility.all.value)
    depth: Mapped[int] = mapped_column(Integer, default=1)
    created_by_id: Mapped[int | None] = mapped_column(ForeignKey("users.id"), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, onupdate=utcnow)
    deleted_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True, index=True)
    deleted_by_id: Mapped[int | None] = mapped_column(ForeignKey("users.id"), nullable=True)

    parent: Mapped["Folder | None"] = relationship(remote_side=[id])


Index(
    "uq_folder_sibling_name",
    "parent_id",
    "name",
    unique=True,
    sqlite_where=text("deleted_at IS NULL"),
)


class ResourceLink(Base):
    __tablename__ = "resource_links"

    id: Mapped[int] = mapped_column(primary_key=True)
    folder_id: Mapped[int | None] = mapped_column(ForeignKey("workspace_folders.id"), nullable=True, index=True)
    task_id: Mapped[int | None] = mapped_column(ForeignKey("tasks.id"), nullable=True, index=True)
    title: Mapped[str] = mapped_column(String(200))
    url: Mapped[str] = mapped_column(String(2048))
    description: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_by_id: Mapped[int | None] = mapped_column(ForeignKey("users.id"), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, onupdate=utcnow)
    deleted_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True, index=True)
    deleted_by_id: Mapped[int | None] = mapped_column(ForeignKey("users.id"), nullable=True)

    folder: Mapped["Folder | None"] = relationship()
    creator: Mapped["User | None"] = relationship(foreign_keys=[created_by_id])
    tags: Mapped[list["ResourceLinkTag"]] = relationship(
        back_populates="link", cascade="all, delete-orphan", lazy="selectin"
    )


class ResourceLinkTag(Base):
    __tablename__ = "resource_link_tags"

    id: Mapped[int] = mapped_column(primary_key=True)
    link_id: Mapped[int] = mapped_column(ForeignKey("resource_links.id", ondelete="CASCADE"), index=True)
    tag: Mapped[str] = mapped_column(String(30), index=True)

    link: Mapped["ResourceLink"] = relationship(back_populates="tags")