from __future__ import annotations

from datetime import timedelta

from fastapi import APIRouter, Depends, Request, Response
from sqlalchemy import delete, func, select
from sqlalchemy.orm import Session

from app import audit, policy
from app.config import settings
from app.db import get_db, write_tx
from app.deps import CurrentUser, client_ip, get_current_user
from app.errors import unauthorized, unprocessable
from app.models import EventType, LoginAttempt, SessionRow, User, utcnow
from app.schemas import ChangePasswordIn, LoginIn, SessionInfoOut, UserOut
from app.security import (
    escape_like,
    hash_password,
    new_session_token,
    session_expiry,
    validate_password,
    verify_password,
)

router = APIRouter(prefix="/auth", tags=["auth"])

# FR-AUTH-003. The throttle lives in `login_attempts` rather than a module-level
# dict: an in-memory bucket reset on every restart, counted per worker, and grew
# without bound. It is also what lets one address be throttled regardless of how
# many email addresses it sprays guesses across.
_EMAIL_SCOPE = "email"
_IP_SCOPE = "ip"


def _scopes(email: str, ip: str) -> tuple[str, str]:
    return f"{_EMAIL_SCOPE}:{email.lower()}", f"{_IP_SCOPE}:{ip}"


def _window_start():
    return utcnow() - timedelta(minutes=settings.LOGIN_FAIL_WINDOW_MINUTES)


def _prune(db: Session) -> None:
    db.execute(delete(LoginAttempt).where(LoginAttempt.attempted_at < _window_start()))


def _count(db: Session, scope: str) -> int:
    return int(
        db.scalar(
            select(func.count())
            .select_from(LoginAttempt)
            .where(LoginAttempt.scope == scope, LoginAttempt.attempted_at >= _window_start())
        )
        or 0
    )


def _check_rate_limit(db: Session, email: str, ip: str) -> None:
    email_scope, ip_scope = _scopes(email, ip)
    if _count(db, email_scope) >= settings.LOGIN_FAIL_LIMIT:
        raise unauthorized("TOO_MANY_ATTEMPTS", "Too many failed attempts; try again later")
    if _count(db, ip_scope) >= settings.LOGIN_FAIL_IP_LIMIT:
        raise unauthorized(
            "TOO_MANY_ATTEMPTS", "Too many failed attempts from this network; try again later"
        )


def _record_failure(db: Session, email: str, ip: str) -> None:
    _prune(db)
    now = utcnow()
    for scope in _scopes(email, ip):
        db.add(LoginAttempt(scope=scope, attempted_at=now))


def _clear_failures(db: Session, email: str, ip: str) -> None:
    """Clear only this account's bucket.

    The address-wide bucket is deliberately left alone: otherwise signing in
    once with a valid account — which an attacker often has — would wipe the
    record of every guess they made against every other address.
    """
    db.execute(delete(LoginAttempt).where(LoginAttempt.scope == f"{_EMAIL_SCOPE}:{email.lower()}"))


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
    identifier = (payload.username or payload.email or "").strip().lower()
    if not identifier:
        raise unauthorized("INVALID_CREDENTIALS", "Username or password is incorrect")
    ip = client_ip(request)
    _check_rate_limit(db, identifier, ip)

    user = db.scalar(select(User).where(func.lower(User.email) == identifier))
    if user is None and "@" not in identifier:
        user = db.scalar(
            select(User).where(
                (func.lower(User.display_name) == identifier)
                | (func.lower(User.full_name) == identifier)
                | (func.lower(User.email).like(f"{escape_like(identifier)}@%", escape="\\"))
            )
        )
    if user is None:
        from app.security import dummy_verify

        dummy_verify()
        _record_failure(db, identifier, ip)
        db.commit()
        raise unauthorized("INVALID_CREDENTIALS", "Username or password is incorrect")

    if not verify_password(user.password_hash, payload.password) or not user.is_active:
        _record_failure(db, identifier, ip)
        db.commit()
        raise unauthorized("INVALID_CREDENTIALS", "Username or password is incorrect")

    _clear_failures(db, identifier, ip)
    _clear_failures(db, user.email, ip)
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