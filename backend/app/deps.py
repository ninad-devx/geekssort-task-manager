from __future__ import annotations

from datetime import timedelta

from fastapi import Depends, Request
from sqlalchemy import select
from sqlalchemy.orm import Session

from app import audit
from app.config import settings
from app.db import get_db
from app.errors import AppError, forbidden, unauthorized
from app.models import SessionRow, User, utcnow
from app.policy import capabilities

SAFE_METHODS = {"GET", "HEAD", "OPTIONS"}


def enforce_csrf(request: Request) -> None:
    """SameSite=Lax + Origin check + mandatory custom header (D-04)."""
    if request.method in SAFE_METHODS:
        return
    if request.url.path in {"/api/auth/login", "/api/auth/logout"}:
        return  # login must work before a session exists; both are SameSite=Lax protected

    if request.headers.get(settings.CSRF_HEADER_NAME) != settings.CSRF_HEADER_VALUE:
        raise forbidden("CSRF_HEADER_MISSING", "Missing or invalid X-Requested-With header")

    origin = request.headers.get("origin")
    if origin:
        host = request.headers.get("host")
        if origin not in settings.origin_allowlist and (
            host is None or origin.split("//")[-1] != host
        ):
            raise forbidden("ORIGIN_NOT_ALLOWED", "Origin is not allowed")


def load_session(request: Request, db: Session) -> tuple[SessionRow, User]:
    from app.security import hash_token

    token = request.cookies.get(settings.COOKIE_NAME)
    if not token:
        raise unauthorized()

    row = db.scalar(select(SessionRow).where(SessionRow.token_hash == hash_token(token)))
    if row is None:
        raise unauthorized()

    now = utcnow()
    if row.expires_at <= now or row.absolute_expires_at <= now:
        db.delete(row)
        db.commit()
        raise unauthorized("SESSION_EXPIRED", "Session expired")

    user = db.get(User, row.user_id)
    if user is None or not user.is_active:
        db.delete(row)
        db.commit()
        raise unauthorized()

    # Resolve the role's powers once per request so a permission change made by
    # an admin applies to the very next request, with no restart.
    from app.permissions import resolve

    user._resolved_permissions = resolve(db, user.role)

    # sliding idle window, written at most every 5 minutes
    if (now - row.last_seen_at) > timedelta(minutes=settings.SESSION_TOUCH_MINUTES):
        row.last_seen_at = now
        row.expires_at = audit_now_plus_idle(now)
        db.commit()

    return row, user


def audit_now_plus_idle(now):
    return now + timedelta(hours=settings.SESSION_IDLE_HOURS)


class CurrentUser:
    def __init__(self, user: User, session: SessionRow):
        self.user = user
        self.session = session

    @property
    def id(self) -> int:
        return self.user.id

    @property
    def caps(self) -> dict[str, bool]:
        return capabilities(self.user)


def get_current_user(request: Request, db: Session = Depends(get_db)) -> CurrentUser:
    session_row, user = load_session(request, db)
    if user.must_change_password and request.url.path not in {
        "/api/auth/me",
        "/api/auth/change-password",
        "/api/auth/logout",
    }:
        raise forbidden("PASSWORD_CHANGE_REQUIRED", "Change your password to continue")
    return CurrentUser(user, session_row)


def require_admin(current: CurrentUser = Depends(get_current_user)) -> CurrentUser:
    if not current.user.is_admin:
        raise forbidden("ADMIN_ONLY", "This action requires the admin flag")
    return current


def client_ip(request: Request) -> str:
    return (request.client.host if request.client else "unknown")


def set_request_context(request: Request) -> None:
    audit.set_request_id(audit.new_request_id())