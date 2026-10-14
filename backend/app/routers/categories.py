"""Admin-managed task categories.

The built-in set is seeded on first read, so an existing database picks it up
without a migration. Renaming is safe because tasks store the slug; retiring a
category hides it from the pickers but leaves every existing task readable.
"""

from __future__ import annotations

import re

from fastapi import APIRouter, Depends
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app import audit
from app.db import get_db, write_tx
from app.deps import CurrentUser, require_admin
from app.errors import conflict, not_found, unprocessable
from app.models import Category, EventType, Task, utcnow
from app.schemas import CategoryIn, CategoryOut

router = APIRouter(prefix="/categories", tags=["categories"])

DEFAULTS: list[tuple[str, str]] = [
    ("content", "Content"),
    ("social_media", "Social media"),
    ("campaign", "Campaign"),
    ("leads_outreach", "Leads & outreach"),
    ("events", "Events"),
    ("competitor_research", "Competitor research"),
    ("company_resources", "Company resources"),
    ("other", "Other"),
]

SLUG_RE = re.compile(r"[^a-z0-9_]+")


def _by_slug(db: Session, slug: str) -> Category | None:
    return db.scalar(select(Category).where(Category.slug == slug))


def ensure_defaults(db: Session) -> None:
    missing = [
        (slug, label, index)
        for index, (slug, label) in enumerate(DEFAULTS)
        if _by_slug(db, slug) is None
    ]
    if not missing:
        return
    for slug, label, index in missing:
        db.add(Category(slug=slug, label=label, is_active=True, sort_order=index))
    db.flush()


def _counts(db: Session) -> dict[str, int]:
    rows = db.execute(
        select(Task.category, func.count())
        .where(Task.category.is_not(None), Task.deleted_at.is_(None))
        .group_by(Task.category)
    ).all()
    return {slug: int(count) for slug, count in rows}


def _out(row: Category, counts: dict[str, int]) -> CategoryOut:
    return CategoryOut(
        slug=row.slug,
        label=row.label,
        is_active=row.is_active,
        sort_order=row.sort_order,
        task_count=counts.get(row.slug, 0),
    )


@router.get("", response_model=list[CategoryOut])
def list_categories(
    current: CurrentUser = Depends(require_admin),
    db: Session = Depends(get_db),
):
    ensure_defaults(db)
    db.commit()
    counts = _counts(db)
    rows = db.scalars(select(Category).order_by(Category.sort_order, Category.label)).all()
    return [_out(row, counts) for row in rows]


@router.post("", response_model=CategoryOut, status_code=201)
def create_category(
    payload: CategoryIn,
    current: CurrentUser = Depends(require_admin),
):
    label = payload.label.strip()
    slug = SLUG_RE.sub("_", label.lower()).strip("_")
    if not slug:
        raise unprocessable("INVALID_CATEGORY", "That name does not produce a usable slug")

    with write_tx() as db:
        ensure_defaults(db)
        if _by_slug(db, slug) is not None:
            raise conflict("CATEGORY_TAKEN", "A category with that name already exists")
        now = utcnow()
        row = Category(
            slug=slug, label=label, is_active=True, sort_order=payload.sort_order, updated_at=now
        )
        db.add(row)
        db.flush()
        audit.record(
            db,
            event_type=EventType.category_created.value,
            entity_type="category",
            entity_id=row.id,
            actor=current.user,
            summary=f"Category “{label}” created",
            after={"slug": slug, "label": label},
            created_at=now,
        )
        return _out(row, _counts(db))


@router.patch("/{slug}", response_model=CategoryOut)
def update_category(
    slug: str,
    payload: CategoryIn,
    current: CurrentUser = Depends(require_admin),
):
    with write_tx() as db:
        ensure_defaults(db)
        row = _by_slug(db, slug)
        if row is None:
            raise not_found("CATEGORY_NOT_FOUND", "Category not found")
        before = {"label": row.label, "is_active": row.is_active, "sort_order": row.sort_order}
        if payload.label is not None and payload.label.strip():
            row.label = payload.label.strip()
        if payload.sort_order is not None:
            row.sort_order = payload.sort_order
        if payload.is_active is not None:
            row.is_active = payload.is_active
        now = utcnow()
        row.updated_at = now
        db.flush()
        after = {"label": row.label, "is_active": row.is_active, "sort_order": row.sort_order}
        if before != after:
            audit.record(
                db,
                event_type=EventType.category_updated.value,
                entity_type="category",
                entity_id=row.id,
                actor=current.user,
                summary=f"Category “{row.label}” updated",
                before=before,
                after=after,
                created_at=now,
            )
        return _out(row, _counts(db))


@router.delete("/{slug}", response_model=CategoryOut)
def retire_category(slug: str, current: CurrentUser = Depends(require_admin)):
    """Retire rather than hard-delete: tasks still reference this slug."""
    with write_tx() as db:
        ensure_defaults(db)
        row = _by_slug(db, slug)
        if row is None:
            raise not_found("CATEGORY_NOT_FOUND", "Category not found")
        now = utcnow()
        row.is_active = False
        row.updated_at = now
        db.flush()
        audit.record(
            db,
            event_type=EventType.category_updated.value,
            entity_type="category",
            entity_id=row.id,
            actor=current.user,
            summary=f"Category “{row.label}” retired",
            before={"is_active": True},
            after={"is_active": False},
            created_at=now,
        )
        return _out(row, _counts(db))
