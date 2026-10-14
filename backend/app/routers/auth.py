from __future__ import annotations

import time
from collections import defaultdict, deque

from fastapi import APIRouter, Depends, Request, Response
from sqlalchemy import delete, select
from sqlalchemy.orm import Session

from app import audit, policy
from app.config import settings
from app.db import get_db, write_tx
from app.deps import CurrentUser, client_ip, get_current_user
from app.errors import unauthorized, unprocessable
from app.models import EventType, SessionRow, User, utcnow
from app.schemas import ChangePasswordIn, LoginIn, SessionInfoOut, UserOut
from app.security import (
    hash_password,
    new_session_token,
    session_expiry,
    validate_password,
    verify_password,
)

router = APIRouter(prefix="/auth", tags=["auth"])

# FR-AUTH-003: in-memory, single worker (D-12)
_failures: dict[tuple[str, str], deque] = defaultdict(deque)


def _check_rate_limit(email: str, ip: str) -> None:
    key = (email.lower(), ip)
    bucket = _failures[key]
    now = time.time()
    window = settings.LOGIN_FAIL_WINDOW_MINUTES * 60
    while bucket and now - bucket[0] > window:
        bucket.popleft()
    if len(bucket) >= settings.LOGIN_FAIL_LIMIT:
        raise unauthorized("TOO_MANY_ATTEMPTS", "Too many failed attempts; try again later")


def _record_failure(email: str, ip: str) -> None:
    _failures[(email.lower(), ip)].append(time.time())


def _clear_failures(email: str, ip: str) -> None:
    _failures.pop((email.lower(), ip), None)


def _set_cookie(response: Response, token: str) -> None:
    idle_seconds = settings.SESSION_IDLE_HOURS * 3600
    response.set_cookie(
        settings.COOKIE_NAME,
        token,
        max_age=idle_seconds,
        httponly=True,
        samesite="lax",
        secure=settings.COOKIE_SECURE,
        path="/",
    )


def session_info(user: User) -> SessionInfoOut:
    return SessionInfoOut(
        user=UserOut(
            id=user.id,
            email=user.email,
            full_name=user.full_name,
            display_name=user.display_name,
            avatar_url=user.avatar_url,
            avatar_color=user.avatar_color,
            role=user.role,
            is_admin=user.is_admin,
            can_review=user.can_review,
            is_active=user.is_active,
            must_change_password=user.must_change_password,
            created_at=user.created_at,
        ),
        capabilities=policy.capabilities(user),
        server_time=utcnow(),
        app_timezone=settings.APP_TIMEZONE,
    )


@router.post("/login", response_model=SessionInfoOut)
def login(payload: LoginIn, request: Request, response: Response, db: Session = Depends(get_db)):
    email = payload.email.strip().lower()
    ip = client_ip(request)
    _check_rate_limit(email, ip)

    user = db.scalar(select(User).where(User.email == email))
    if user is None:
        from app.security import dummy_verify

        dummy_verify()
        _record_failure(email, ip)
        raise unauthorized("INVALID_CREDENTIALS", "Email or password is incorrect")

    if not verify_password(user.password_hash, payload.password) or not user.is_active:
        _record_failure(email, ip)
        raise unauthorized("INVALID_CREDENTIALS", "Email or password is incorrect")

    _clear_failures(email, ip)
    now = utcnow()
    token, token_hash = new_session_token()
    idle_expires, absolute_expires = session_expiry(now)
    db.add(
        SessionRow(
            user_id=user.id,
            token_hash=token_hash,
            created_at=now,
            last_seen_at=now,
            expires_at=idle_expires,
            absolute_expires_at=absolute_expires,
            ip=ip,
            user_agent=(request.headers.get("user-agent") or "")[:255],
        )
    )
    db.commit()
    _set_cookie(response, token)
    return session_info(user)


@router.post("/logout", status_code=204)
def logout(response: Response, current: CurrentUser = Depends(get_current_user), db: Session = Depends(get_db)):
    db.execute(delete(SessionRow).where(SessionRow.id == current.session.id))
    db.commit()
    response.delete_cookie(settings.COOKIE_NAME, path="/")


@router.get("/me", response_model=SessionInfoOut)
def me(current: CurrentUser = Depends(get_current_user)):
    return session_info(current.user)


@router.post("/change-password", status_code=204)
def change_password(
    payload: ChangePasswordIn,
    current: CurrentUser = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    user = current.user
    if not verify_password(user.password_hash, payload.current_password):
        raise unauthorized("INVALID_CREDENTIALS", "Current password is incorrect")
    problem = validate_password(payload.new_password, user.email)
    if problem:
        raise unprocessable("WEAK_PASSWORD", problem)

    with write_tx() as wdb:
        target = wdb.get(User, user.id)
        target.password_hash = hash_password(payload.new_password)
        target.must_change_password = False
        # FR-AUTH-008: delete all *other* sessions
        wdb.execute(
            delete(SessionRow).where(SessionRow.user_id == target.id, SessionRow.id != current.session.id)
        )
        audit.record(
            wdb,
            event_type=EventType.password_changed.value,
            entity_type="user",
            entity_id=target.id,
            actor=target,
            summary=f"{target.full_name} changed their password",
        )
    return None