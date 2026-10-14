"""Audit writer. One event per distinct change, same transaction as the change (FR-AUDIT-002)."""

from __future__ import annotations

import json
import uuid
from datetime import datetime
from typing import Any

from sqlalchemy.orm import Session

from app.models import AuditEvent, User

_request_id: dict[str, str] = {}


def new_request_id() -> str:
    return uuid.uuid4().hex


def current_request_id() -> str:
    return _request_id.get("id") or "system"


def set_request_id(value: str) -> None:
    _request_id["id"] = value


def _dump(value: Any) -> str | None:
    if value is None:
        return None
    return json.dumps(value, default=str, sort_keys=True)


def record(
    db: Session,
    *,
    event_type: str,
    entity_type: str,
    entity_id: int,
    summary: str,
    actor: User | None = None,
    task_id: int | None = None,
    before: Any = None,
    after: Any = None,
    meta: Any = None,
    created_at: datetime | None = None,
) -> AuditEvent:
    event = AuditEvent(
        event_type=event_type,
        request_id=current_request_id(),
        actor_id=actor.id if actor else None,
        actor_name=actor.full_name if actor else "system",
        entity_type=entity_type,
        entity_id=entity_id,
        task_id=task_id,
        summary=summary,
        before_json=_dump(before),
        after_json=_dump(after),
        meta_json=_dump(meta),
        created_at=created_at,
    )
    db.add(event)
    db.flush()
    return event


def diff_fields(before: dict, after: dict, fields: list[str]) -> tuple[dict, dict] | None:
    b = {f: before.get(f) for f in fields}
    a = {f: after.get(f) for f in fields}
    if b == a:
        return None  # no-op update writes nothing
    return b, a