from __future__ import annotations

import hashlib
import re
import secrets
import string
from datetime import datetime, timedelta
from urllib.parse import urlparse

from argon2 import PasswordHasher
from argon2.exceptions import InvalidHashError, VerificationError, VerifyMismatchError

from app.config import settings
from app.models import utcnow

_hasher = PasswordHasher()


def hash_password(password: str) -> str:
    return _hasher.hash(password)


def verify_password(stored_hash: str | None, password: str) -> bool:
    if not stored_hash:
        return False
    try:
        return _hasher.verify(stored_hash, password)
    except (VerifyMismatchError, VerificationError, InvalidHashError):
        return False


DUMMY_HASH = hash_password(secrets.token_urlsafe(24))


def dummy_verify() -> None:
    """Burn comparable CPU on unknown emails so timing does not leak existence (FR-AUTH-002)."""
    try:
        _hasher.verify(DUMMY_HASH, "not-the-password")
    except (VerifyMismatchError, VerificationError, InvalidHashError):
        pass


def new_session_token() -> tuple[str, str]:
    token = secrets.token_urlsafe(32)
    return token, hash_token(token)


def hash_token(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def session_expiry(now: datetime | None = None) -> tuple[datetime, datetime]:
    now = now or utcnow()
    return (
        now + timedelta(hours=settings.SESSION_IDLE_HOURS),
        now + timedelta(days=settings.SESSION_ABSOLUTE_DAYS),
    )


TEMP_ALPHABET = string.ascii_letters + string.digits


def generate_temp_password() -> str:
    while True:
        candidate = "".join(secrets.choice(TEMP_ALPHABET) for _ in range(settings.TEMP_PASSWORD_LENGTH))
        if any(c.isupper() for c in candidate) and any(c.isdigit() for c in candidate):
            return candidate


def validate_password(password: str, email: str) -> str | None:
    if len(password) < settings.MIN_PASSWORD_LENGTH or len(password) > 128:
        return f"Password must be {settings.MIN_PASSWORD_LENGTH}-128 characters"
    if password.strip().lower() == email.strip().lower():
        return "Password must not equal the email"
    return None


SAFE_SCHEMES = {"http", "https"}


def validate_url(url: str) -> str | None:
    if len(url) > 2048:
        return "URL must be at most 2048 characters"
    try:
        parsed = urlparse(url)
    except ValueError:
        return "URL is not valid"
    if parsed.scheme.lower() not in SAFE_SCHEMES:
        return "URL scheme must be http or https"
    if not parsed.hostname:
        return "URL must include a host"
    if parsed.username or parsed.password:
        return "URL must not embed credentials"
    return None


def is_safe_url(url: str) -> bool:
    return validate_url(url) is None


def validate_evidence_url(url: str | None) -> str | None:
    if url is None or url == "":
        return None
    return validate_url(url)


TAG_RE = re.compile(r"^[a-z0-9 _-]+$")


def normalize_tag(tag: str) -> str:
    return " ".join(tag.strip().lower().split())


def escape_like(term: str) -> str:
    return term.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")