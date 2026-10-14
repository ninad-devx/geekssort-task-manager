"""Admin-only editing of what each role may do.

Authorization itself never lives here — this only stores the matrix that
`app/policy.py` reads. Every change is written in the same transaction as its
audit event, and a role with no row falls back to its built-in defaults.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends
from sqlalchemy import select
from sqlalchemy.orm import Session

from app import audit, permissions
from app.db import get_db, write_tx
from app.deps import CurrentUser, require_admin
from app.errors import unprocessable
from app.models import EventType, Role, RolePermission, utcnow
from app.schemas import (
    PermissionInfo,
    PermissionsMatrixOut,
    RolePermissionsIn,
    RolePermissionsOut,
)

router = APIRouter(prefix="/permissions", tags=["permissions"])


def _role_out(db: Session, role: Role) -> RolePermissionsOut:
    row = db.get(RolePermission, role.value)
    defaults = permissions.defaults_for(role.value)
    return RolePermissionsOut(
        role=role,
        permissions=sorted(permissions.resolve(db, role.value)),
        defaults=sorted(defaults),
        is_default=row is None,
        updated_at=row.updated_at if row else None,
    )


@router.get("", response_model=PermissionsMatrixOut)
def read_matrix(
    current: CurrentUser = Depends(require_admin),
    db: Session = Depends(get_db),
):
    return PermissionsMatrixOut(
        permissions=[PermissionInfo(key=k, label=label) for k, label in permissions.PERMISSION_KEYS],
        roles=[_role_out(db, role) for role in Role],
    )


@router.put("/{role}", response_model=RolePermissionsOut)
def update_role(
    role: Role,
    payload: RolePermissionsIn,
    current: CurrentUser = Depends(require_admin),
):
    unknown = sorted(set(payload.permissions) - permissions.PERMISSION_NAMES)
    if unknown:
        raise unprocessable("UNKNOWN_PERMISSION", "Unrecognised permissions", unknown=unknown)

    granted = sorted(set(payload.permissions) & permissions.PERMISSION_NAMES)
    with write_tx() as db:
        row = db.get(RolePermission, role.value)
        before = sorted(permissions._decode(row.permissions_json)) if row else None
        now = utcnow()
        if row is None:
            row = RolePermission(role=role.value, updated_by_id=current.user.id, updated_at=now)
            db.add(row)
        row.permissions_json = permissions.encode(granted)
        row.updated_by_id = current.user.id
        row.updated_at = now
        db.flush()
        audit.record(
            db,
            event_type=EventType.role_permissions_updated.value,
            entity_type="role",
            entity_id=permissions.role_entity_id(role.value),
            actor=current.user,
            summary=f"Permissions for role {role.value} set to {len(granted)}",
            before=None if before is None else {"permissions": before},
            after={"permissions": granted},
            meta={"role": role.value},
            created_at=now,
        )
        out = _role_out(db, role)
    return out


@router.delete("/{role}", response_model=RolePermissionsOut)
def reset_role(
    role: Role,
    current: CurrentUser = Depends(require_admin),
):
    with write_tx() as db:
        row = db.get(RolePermission, role.value)
        before = sorted(permissions._decode(row.permissions_json)) if row else None
        if row is not None:
            db.delete(row)
            db.flush()
        now = utcnow()
        audit.record(
            db,
            event_type=EventType.role_permissions_updated.value,
            entity_type="role",
            entity_id=permissions.role_entity_id(role.value),
            actor=current.user,
            summary=f"Permissions for role {role.value} reset to defaults",
            before=None if before is None else {"permissions": before},
            after={"permissions": sorted(permissions.defaults_for(role.value))},
            meta={"role": role.value},
            created_at=now,
        )
        return _role_out(db, role)