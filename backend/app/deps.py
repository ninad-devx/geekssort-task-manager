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
DEFAULT_PORTS = {"http": "80", "https": "443", "ws": "80", "wss": "443"}


def _split_authority(value: str) -> tuple[str, str | None]:
    """Split a `host[:port]` pair into a lowercase (host, port) tuple."""
    value = value.strip().lower()
    if value.startswith("["):  # IPv6 literal, e.g. [::1]:8000
        host, sep, port = value.rpartition("]:")
        return (f"[{host}]", port) if sep else (value, None)
    host, sep, port = value.rpartition(":")
    if sep and port.isdigit():
        return host, port
    return value, None


def _is_own_origin(origin: str, request: Request) -> bool:
    """Is `origin` the same origin this request was addressed to?

    `Host` cannot answer that on its own. The browser reaches the API through
    the Next.js rewrite, which proxies upstream with `changeOrigin: true` and so
    replaces `Host` with the API's own address; the browser's hostname only
    survives in `X-Forwarded-Host`. Comparing against `Host` alone therefore
    rejected every write in production with ORIGIN_NOT_ALLOWED, while local dev
    passed only because DEV_ORIGINS happened to list it.

    `X-Forwarded-Host` is trusted without consulting TRUST_PROXY_HEADERS because
    nothing here can be leveraged: reaching this point already requires the
    custom `X-Requested-With` header, which forces a preflight that CORSMiddleware
    only answers for an allowlisted origin. A caller outside a browser has no
    ambient cookie to abuse.
    """
    scheme, sep, authority = origin.partition("//")
    if not sep:
        return False  # the literal "null" that a sandboxed frame or file:// sends
    origin_host, origin_port = _split_authority(authority)
    default = DEFAULT_PORTS.get(scheme.removesuffix(":").lower())

    for header in ("host", "x-forwarded-host"):
        raw = request.headers.get(header)
        if not raw:
            continue
        # nginx appends to X-Forwarded-Host; the client-facing value comes first.
        host, port = _split_authority(raw.split(",")[0])
        if host != origin_host:
            continue
        if origin_port is None or port == origin_port:
            return True
        # `https://a.example` and `https://a.example:443` are one origin (RFC 6454).
        if {origin_port, port} == {None, default}:
            return True
    return False


def enforce_csrf(request: Request) -> None:
    """SameSite=Lax + Origin check + mandatory custom header (D-04)."""
    if request.method in SAFE_METHODS:
        return
    if request.url.path in {"/api/auth/login", "/api/auth/logout"}:
        return  # login must work before a session exists; both are SameSite=Lax protected

    if request.headers.get(settings.CSRF_HEADER_NAME) != settings.CSRF_HEADER_VALUE:
        raise forbidden("CSRF_HEADER_MISSING", "Missing or invalid X-Requested-With header")

    origin = request.headers.get("origin")
    if origin and origin not in settings.origin_allowlist and not _is_own_origin(origin, request):
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
    """The address the throttle keys on.

    `X-Forwarded-For` is only honoured when the deployment says a proxy is in
    front. Trusting it unconditionally would let any client announce a fresh
    address on every request and walk straight through the login limit.
    """
    if settings.TRUST_PROXY_HEADERS:
        forwarded = request.headers.get("x-forwarded-for")
        if forwarded:
            return forwarded.split(",")[0].strip()[:64]
    return (request.client.host if request.client else "unknown")


def set_request_context(request: Request) -> None:
    audit.set_request_id(audit.new_request_id())