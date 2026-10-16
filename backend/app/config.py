from __future__ import annotations

from functools import lru_cache
from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict

BACKEND_DIR = Path(__file__).resolve().parent.parent
REPO_DIR = BACKEND_DIR.parent


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=str(BACKEND_DIR / ".env"),
        env_file_encoding="utf-8",
        extra="ignore",
    )

    APP_NAME: str = "Taskssort"
    APP_TIMEZONE: str = "UTC"
    DATABASE_URL: str = f"sqlite:///{BACKEND_DIR / 'data' / 'marketingos.db'}"

    COOKIE_NAME: str = "mos_session"
    COOKIE_SECURE: bool = False
    SESSION_IDLE_HOURS: int = 12
    SESSION_ABSOLUTE_DAYS: int = 7
    SESSION_TOUCH_MINUTES: int = 5
    LOGIN_FAIL_LIMIT: int = 5
    # A second bucket keyed on the client address alone. Without it one attacker
    # can spray a single password guess across every email and never trip the
    # per-(email, ip) limit.
    LOGIN_FAIL_IP_LIMIT: int = 25
    LOGIN_FAIL_WINDOW_MINUTES: int = 15
    # Only enable behind a proxy you control, otherwise a client can spoof its
    # own address and walk straight through the rate limit.
    TRUST_PROXY_HEADERS: bool = False
    CSRF_HEADER_NAME: str = "x-requested-with"
    CSRF_HEADER_VALUE: str = "marketingos"

    MAX_TIMER_HOURS: int = 12
    MAX_SESSION_HOURS: int = 24
    CLOCK_SKEW_ALLOWANCE_MINUTES: int = 2

    MEMBER_CAN_CREATE_TASKS: bool = True
    MEMBER_CAN_DELETE_ASSIGNED_TASKS: bool = False
    MEMBER_CAN_EDIT_TIME: bool = True
    TIME_EDIT_WINDOW_DAYS: int = 0
    MEMBER_CAN_ADD_LINKS: bool = True
    MEMBER_CAN_CREATE_FOLDERS: bool = False

    MIN_PASSWORD_LENGTH: int = 10
    TEMP_PASSWORD_LENGTH: int = 16

    DEV_ORIGINS: str = "http://localhost:3000,http://127.0.0.1:3000"

    @property
    def tz(self):
        from zoneinfo import ZoneInfo

        return ZoneInfo(self.APP_TIMEZONE)

    @property
    def origin_allowlist(self) -> set[str]:
        return {o.strip() for o in self.DEV_ORIGINS.split(",") if o.strip()}


@lru_cache
def get_settings() -> Settings:
    return Settings()


settings = get_settings()