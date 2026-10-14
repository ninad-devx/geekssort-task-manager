from __future__ import annotations

from fastapi import APIRouter, Depends, Query
from sqlalchemy import Select, or_, select
from sqlalchemy.orm import Session

from app import audit, policy
from app.db import get_db, write_tx
from app.deps import CurrentUser, get_current_user
from app.errors import conflict, forbidden, not_found, unprocessable
from app.models import (
    EventType,
    Folder,
    ResourceLink,
    ResourceLinkTag,
    Visibility,
    utcnow)
from app.schemas import (
    FolderCreateIn,
    FolderMoveIn,
    FolderOut,
    FolderUpdateIn,
    LinkCreateIn,
    LinkOut,
    LinkUpdateIn,
)
from app.security import TAG_RE, normalize_tag, validate_url
from app.serializers import folder_out, link_out

router = APIRouter(prefix="/workspace", tags=["workspace"])

MAX_DEPTH = 6


def _visible_folders_stmt(current: CurrentUser) -> Select:
    stmt = select(Folder).where(Folder.deleted_at.is_(None))
    scope = policy.folder_query_scope(current.user)
    if scope is not None:
        stmt = stmt.where(scope)
    return stmt


def _load_folder(current: CurrentUser, db: Session, folder_id: int) -> Folder:
    folder = db.get(Folder, folder_id)
    if folder is None or folder.deleted_at is not None or not policy.can_view_folder(current.user, folder):
        raise not_found("FOLDER_NOT_FOUND", "Folder not found")
    return folder


def _visible_folder_exists(current: CurrentUser, db: Session, folder_id: int) -> bool:
    folder = db.get(Folder, folder_id)
    return folder is not None and folder.deleted_at is None and policy.can_view_folder(current.user, folder)


def _load_link(current: CurrentUser, db: Session, link_id: int) -> ResourceLink:
    link = db.get(ResourceLink, link_id)
    if link is None or link.deleted_at is not None:
        raise not_found("LINK_NOT_FOUND", "Link not found")
    if link.folder_id is not None:
        folder = db.get(Folder, link.folder_id)
        if folder is None or not policy.can_view_folder(current.user, folder):
            raise not_found("LINK_NOT_FOUND", "Link not found")
    return link


def _depth_of(db: Session, parent: Folder | None) -> int:
    return (parent.depth + 1) if parent else 1


def _descendants(db: Session, folder: Folder) -> list[int]:
    out: list[int] = []
    frontier = [folder.id]
    while frontier:
        children = db.scalars(
            select(Folder.id).where(Folder.parent_id.in_(frontier), Folder.deleted_at.is_(None))
        ).all()
        frontier = [c for c in children if c not in out]
        out.extend(frontier)
    return out


def _cascade_visibility(db: Session, folder: Folder, visibility: str, now) -> list[Folder]:
    touched = [folder]
    folder.visibility = visibility
    for child_id in _descendants(db, folder):
        child = db.get(Folder, child_id)
        if child is not None and child.visibility != visibility:
            child.visibility = visibility
            child.updated_at = now
            touched.append(child)
    return touched


def _validate_tags(tags: list[str]) -> list[str]:
    cleaned: list[str] = []
    for raw in tags[:10]:
        tag = normalize_tag(raw)
        if not tag:
            continue
        if len(tag) > 30:
            raise unprocessable("INVALID_TAG", "Each tag is at most 30 characters")
        if not TAG_RE.match(tag):
            raise unprocessable("INVALID_TAG", "Tags may use lowercase letters, digits, space, _ and -")
        if tag not in cleaned:
            cleaned.append(tag)
    return cleaned


def _set_tags(db: Session, link: ResourceLink, tags: list[str]) -> None:
    link.tags.clear()
    db.flush()
    for tag in tags:
        db.add(ResourceLinkTag(link_id=link.id, tag=tag))
    db.flush()


# --- folders ---------------------------------------------------------------

@router.get("/folders", response_model=list[FolderOut])
def list_folders(current: CurrentUser = Depends(get_current_user), db: Session = Depends(get_db)):
    rows = db.scalars(_visible_folders_stmt(current).order_by(Folder.name)).all()
    return [folder_out(current.user, f, db) for f in rows]


@router.post("/folders", response_model=FolderOut, status_code=201)
def create_folder(payload: FolderCreateIn, current: CurrentUser = Depends(get_current_user)):
    if not policy.capabilities(current.user)["can_create_folders"]:
        raise forbidden("CANNOT_CREATE_FOLDERS", "Creating folders is not allowed for your role")
    visibility = payload.visibility.value
    if visibility == Visibility.management.value and not policy.is_lead(current.user):
        raise forbidden("FIELD_NOT_ALLOWED", "Only a team lead can create management-only folders")

    with write_tx() as db:
        parent = None
        if payload.parent_id is not None:
            parent = _load_folder(current, db, payload.parent_id)
            if parent.visibility == Visibility.management.value:
                visibility = Visibility.management.value
        depth = _depth_of(db, parent)
        if depth > MAX_DEPTH:
            raise unprocessable("MAX_DEPTH", f"Folders may be nested {MAX_DEPTH} deep")

        name = payload.name.strip()
        exists = db.scalar(
            select(Folder.id).where(
                Folder.parent_id == (parent.id if parent else None),
                func_lower(Folder.name) == name.lower(),
                Folder.deleted_at.is_(None),
            )
        )
        if exists:
            raise conflict("DUPLICATE_FOLDER_NAME", "A sibling folder with that name already exists")

        now = utcnow()
        folder = Folder(
            name=name,
            description=payload.description,
            parent_id=parent.id if parent else None,
            visibility=visibility,
            depth=depth,
            created_by_id=current.user.id,
            created_at=now,
            updated_at=now,
        )
        db.add(folder)
        db.flush()
        audit.record(
            db,
            event_type=EventType.folder_created.value,
            entity_type="folder",
            entity_id=folder.id,
            actor=current.user,
            summary=f"Folder “{folder.name}” created",
            after={"name": folder.name, "parent_id": folder.parent_id, "visibility": visibility},
            created_at=now,
        )
        db.flush()
        return folder_out(current.user, folder, db)


def func_lower(column):
    from sqlalchemy import func

    return func.lower(column)


@router.patch("/folders/{folder_id}", response_model=FolderOut)
def update_folder(
    folder_id: int,
    payload: FolderUpdateIn,
    current: CurrentUser = Depends(get_current_user),
):
    with write_tx() as db:
        # D-10: an invisible folder is a 404 before any role check
        if db.get(Folder, folder_id) is None or not _visible_folder_exists(current, db, folder_id):
            raise not_found("FOLDER_NOT_FOUND", "Folder not found")
        if not policy.can_manage_folder(current.user):
            raise forbidden("LEAD_ONLY", "Only a team lead can manage folders")
        folder = db.get(Folder, folder_id)
        before = {"name": folder.name, "description": folder.description, "visibility": folder.visibility}
        now = utcnow()
        if payload.name is not None:
            name = payload.name.strip()
            clash = db.scalar(
                select(Folder.id).where(
                    Folder.parent_id == folder.parent_id,
                    func_lower(Folder.name) == name.lower(),
                    Folder.id != folder.id,
                    Folder.deleted_at.is_(None),
                )
            )
            if clash:
                raise conflict("DUPLICATE_FOLDER_NAME", "A sibling folder with that name already exists")
            folder.name = name
        if payload.description is not None:
            folder.description = payload.description
        if payload.visibility is not None:
            _cascade_visibility(db, folder, payload.visibility.value, now)
        folder.updated_at = now
        after = {"name": folder.name, "description": folder.description, "visibility": folder.visibility}
        if before != after:
            audit.record(
                db,
                event_type=EventType.folder_updated.value,
                entity_type="folder",
                entity_id=folder.id,
                actor=current.user,
                summary=f"Folder “{folder.name}” updated",
                before=before,
                after=after,
                created_at=now,
            )
        db.flush()
        return folder_out(current.user, folder, db)


@router.post("/folders/{folder_id}/move", response_model=FolderOut)
def move_folder(
    folder_id: int,
    payload: FolderMoveIn,
    current: CurrentUser = Depends(get_current_user),
):
    with write_tx() as db:
        if db.get(Folder, folder_id) is None or not _visible_folder_exists(current, db, folder_id):
            raise not_found("FOLDER_NOT_FOUND", "Folder not found")
        if not policy.can_manage_folder(current.user):
            raise forbidden("LEAD_ONLY", "Only a team lead can manage folders")
        folder = db.get(Folder, folder_id)

        parent = None
        if payload.parent_id is not None:
            parent = _load_folder(current, db, payload.parent_id)
            if parent.id == folder.id or parent.id in _descendants(db, folder):
                raise unprocessable("FOLDER_CYCLE", "A folder cannot be moved under itself or a descendant")

        depth = _depth_of(db, parent)
        if depth > MAX_DEPTH:
            raise unprocessable("MAX_DEPTH", f"Folders may be nested {MAX_DEPTH} deep")

        clash = db.scalar(
            select(Folder.id).where(
                Folder.parent_id == (parent.id if parent else None),
                func_lower(Folder.name) == folder.name.lower(),
                Folder.id != folder.id,
                Folder.deleted_at.is_(None),
            )
        )
        if clash:
            raise conflict("DUPLICATE_FOLDER_NAME", "A sibling folder with that name already exists")

        now = utcnow()
        before = {"parent_id": folder.parent_id, "visibility": folder.visibility}
        folder.parent_id = parent.id if parent else None
        folder.depth = depth
        if parent is not None and parent.visibility == Visibility.management.value:
            _cascade_visibility(db, folder, Visibility.management.value, now)
        db.flush()
        # keep descendant depths consistent
        _redepth(db, folder, now)
        audit.record(
            db,
            event_type=EventType.folder_moved.value,
            entity_type="folder",
            entity_id=folder.id,
            actor=current.user,
            summary=f"Folder “{folder.name}” moved",
            before=before,
            after={"parent_id": folder.parent_id, "visibility": folder.visibility},
            created_at=now,
        )
        db.flush()
        return folder_out(current.user, folder, db)


def _redepth(db: Session, folder: Folder, now) -> None:
    children = db.scalars(
        select(Folder).where(Folder.parent_id == folder.id, Folder.deleted_at.is_(None))
    ).all()
    for child in children:
        child.depth = folder.depth + 1
        child.updated_at = now
        _redepth(db, child, now)


@router.delete("/folders/{folder_id}", response_model=FolderOut)
def delete_folder(folder_id: int, current: CurrentUser = Depends(get_current_user)):
    with write_tx() as db:
        if db.get(Folder, folder_id) is None or not _visible_folder_exists(current, db, folder_id):
            raise not_found("FOLDER_NOT_FOUND", "Folder not found")
        if not policy.can_manage_folder(current.user):
            raise forbidden("LEAD_ONLY", "Only a team lead can manage folders")
        folder = db.get(Folder, folder_id)

        children = int(
            db.scalar(
                select(func_count()).select_from(Folder).where(
                    Folder.parent_id == folder.id, Folder.deleted_at.is_(None)
                )
            )
            or 0
        )
        links = int(
            db.scalar(
                select(func_count()).select_from(ResourceLink).where(
                    ResourceLink.folder_id == folder.id, ResourceLink.deleted_at.is_(None)
                )
            )
            or 0
        )
        if children or links:
            raise conflict(
                "FOLDER_NOT_EMPTY",
                "Empty the folder before deleting it",
                child_folder_count=children,
                link_count=links,
            )

        now = utcnow()
        folder.deleted_at = now
        folder.deleted_by_id = current.user.id
        audit.record(
            db,
            event_type=EventType.folder_deleted.value,
            entity_type="folder",
            entity_id=folder.id,
            actor=current.user,
            summary=f"Folder “{folder.name}” deleted",
            before={"deleted_at": None},
            after={"deleted_at": now},
            created_at=now,
        )
        db.flush()
        return folder_out(current.user, folder, db)


def func_count():
    from sqlalchemy import func

    return func.count()


# --- links -----------------------------------------------------------------

@router.get("/links", response_model=list[LinkOut])
def list_links(
    current: CurrentUser = Depends(get_current_user),
    db: Session = Depends(get_db),
    folder_id: int | None = Query(default=None),
):
    stmt = select(ResourceLink).where(ResourceLink.deleted_at.is_(None))
    if folder_id is not None:
        stmt = stmt.where(ResourceLink.folder_id == folder_id)
    visible_ids = select(Folder.id).where(Folder.deleted_at.is_(None))
    if policy.folder_query_scope(current.user) is not None:
        visible_ids = visible_ids.where(Folder.visibility == Visibility.all.value)
    stmt = stmt.where(
        or_(ResourceLink.folder_id.is_(None), ResourceLink.folder_id.in_(visible_ids))
    )
    rows = db.scalars(stmt.order_by(ResourceLink.title)).all()
    return [link_out(current.user, link) for link in rows]


@router.post("/links", response_model=LinkOut, status_code=201)
def create_link(payload: LinkCreateIn, current: CurrentUser = Depends(get_current_user)):
    if not policy.capabilities(current.user)["can_add_links"]:
        raise forbidden("CANNOT_ADD_LINKS", "Adding links is not allowed for your role")
    problem = validate_url(payload.url)
    if problem:
        raise unprocessable("UNSAFE_URL", problem)
    tags = _validate_tags(payload.tags)

    with write_tx() as db:
        folder = None
        if payload.folder_id is not None:
            folder = _load_folder(current, db, payload.folder_id)
        now = utcnow()
        link = ResourceLink(
            folder_id=folder.id if folder else None,
            title=payload.title.strip(),
            url=payload.url.strip(),
            description=payload.description,
            created_by_id=current.user.id,
            created_at=now,
            updated_at=now,
        )
        db.add(link)
        db.flush()
        _set_tags(db, link, tags)
        audit.record(
            db,
            event_type=EventType.link_created.value,
            entity_type="link",
            entity_id=link.id,
            actor=current.user,
            summary=f"Link “{link.title}” added",
            after={"title": link.title, "url": link.url, "folder_id": link.folder_id, "tags": tags},
            created_at=now,
        )
        db.flush()
        db.refresh(link)
        return link_out(current.user, link)


@router.patch("/links/{link_id}", response_model=LinkOut)
def update_link(
    link_id: int,
    payload: LinkUpdateIn,
    current: CurrentUser = Depends(get_current_user),
):
    with write_tx() as db:
        link = _load_link(current, db, link_id)
        if not policy.can_edit_link(current.user, link):
            raise forbidden("CANNOT_EDIT_LINK", "You may only change your own links")
        before = {
            "title": link.title,
            "url": link.url,
            "description": link.description,
            "folder_id": link.folder_id,
            "tags": [t.tag for t in link.tags],
        }
        if payload.url is not None:
            problem = validate_url(payload.url)
            if problem:
                raise unprocessable("UNSAFE_URL", problem)
            link.url = payload.url.strip()
        if payload.title is not None:
            link.title = payload.title.strip()
        if payload.description is not None:
            link.description = payload.description
        if payload.folder_id is not None:
            folder = _load_folder(current, db, payload.folder_id)
            link.folder_id = folder.id
        if payload.tags is not None:
            _set_tags(db, link, _validate_tags(payload.tags))
        link.updated_at = utcnow()
        after = {
            "title": link.title,
            "url": link.url,
            "description": link.description,
            "folder_id": link.folder_id,
            "tags": [t.tag for t in link.tags],
        }
        if before != after:
            audit.record(
                db,
                event_type=EventType.link_updated.value,
                entity_type="link",
                entity_id=link.id,
                actor=current.user,
                summary=f"Link “{link.title}” updated",
                before=before,
                after=after,
            )
        db.flush()
        db.refresh(link)
        return link_out(current.user, link)


@router.delete("/links/{link_id}", response_model=LinkOut)
def delete_link(link_id: int, current: CurrentUser = Depends(get_current_user)):
    with write_tx() as db:
        link = _load_link(current, db, link_id)
        if not policy.can_edit_link(current.user, link):
            raise forbidden("CANNOT_DELETE_LINK", "You may only delete your own links")
        now = utcnow()
        link.deleted_at = now
        link.deleted_by_id = current.user.id
        audit.record(
            db,
            event_type=EventType.link_deleted.value,
            entity_type="link",
            entity_id=link.id,
            actor=current.user,
            summary=f"Link “{link.title}” deleted",
            before={"title": link.title, "url": link.url, "tags": [t.tag for t in link.tags]},
            after={"deleted_at": now},
            created_at=now,
        )
        db.flush()
        db.refresh(link)
        return link_out(current.user, link)


@router.get("/search")
def search(
    current: CurrentUser = Depends(get_current_user),
    db: Session = Depends(get_db),
    q: str = Query(min_length=2),
):
    """FR-WS-007: escaped wildcards, case-insensitive, only what the caller may see."""
    from app.security import escape_like

    term = f"%{escape_like(q.strip())}%"
    folders = db.scalars(
        _visible_folders_stmt(current).where(
            or_(Folder.name.ilike(term, escape="\\"), Folder.description.ilike(term, escape="\\"))
        ).limit(50)
    ).all()

    visible_ids = select(Folder.id).where(Folder.deleted_at.is_(None))
    if policy.folder_query_scope(current.user) is not None:
        visible_ids = visible_ids.where(Folder.visibility == Visibility.all.value)

    tag_match = ResourceLinkTag.tag.ilike(term, escape="\\")
    links = db.scalars(
        select(ResourceLink)
        .where(
            ResourceLink.deleted_at.is_(None),
            or_(
                ResourceLink.folder_id.is_(None),
                ResourceLink.folder_id.in_(visible_ids),
            ),
            or_(
                ResourceLink.title.ilike(term, escape="\\"),
                ResourceLink.description.ilike(term, escape="\\"),
                ResourceLink.url.ilike(term, escape="\\"),
                ResourceLink.id.in_(select(ResourceLinkTag.link_id).where(tag_match)),
            ),
        )
        .limit(50)
    ).all()

    return {
        "query": q,
        "folders": [folder_out(current.user, f, db) for f in folders],
        "links": [link_out(current.user, link) for link in links],
    }