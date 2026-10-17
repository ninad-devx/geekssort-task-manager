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

    # --- database (PostgreSQL only; ignored for SQLite) --------------------
    # SQLite is a single local file with its own WAL/pragma tuning and its own
    # "pool" of one, so every knob below is deliberately scoped to Postgres.
    DB_POOL_SIZE: int = 5
    DB_MAX_OVERFLOW: int = 5
    DB_POOL_TIMEOUT_SECONDS: int = 30
    # Recycle a pooled connection before the server or any middlebox can drop
    # it idle. 30 min is below the usual 60 min firewall/idle timeout.
    DB_POOL_RECYCLE_SECONDS: int = 1800
    # How long to keep retrying the *first* connection at boot before giving up.
    # 0 means "fail immediately", which is what you want under Compose where
    # `depends_on: service_healthy` already gates startup, and what you want in
    # production so a bad password fails loudly instead of hanging the boot.
    # Raise it only for local experiments with no orchestrator in the loop.
    DB_CONNECT_WAIT_SECONDS: int = 0
    DB_CONNECT_WAIT_INTERVAL_SECONDS: float = 1.0

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

    # --- database introspection ---------------------------------------------
    #
    # These are properties rather than fields so that changing DATABASE_URL at
    # runtime cannot leave a stale cached dialect behind.

    @property
    def database_scheme(self) -> str:
        """The bare driver family: ``sqlite``, ``postgresql`` or ``""``."""
        head = self.DATABASE_URL.strip().split("://", 1)[0]
        return head.split("+", 1)[0].lower()

    @property
    def is_sqlite(self) -> bool:
        return self.database_scheme == "sqlite"

    @property
    def is_postgresql(self) -> bool:
        return self.database_scheme in ("postgresql", "postgres")

    @property
    def resolved_database_url(self) -> str:
        """`DATABASE_URL` with the driver spelled out.

        `postgres://` and a bare `postgresql://` are what most people paste from
        a hosting provider's dashboard. SQLAlchemy reads a bare `postgresql://`
        as psycopg2, which this project does not ship, so it would fail at
        connect time with a driver error that says nothing about which package
        to install. Pinning the driver here keeps that mistake impossible.
        """
        url = self.DATABASE_URL.strip()
        for bare in ("postgres://", "postgresql://"):
            if url.startswith(bare):
                return "postgresql+psycopg://" + url[len(bare) :]
        return url

    @property
    def safe_database_url(self) -> str:
        """`resolved_database_url` with the password replaced by ``***``.

        The only form of the connection string that may reach a log line or an
        error message. Credentials in `.env` are not secrets by themselves --
        this application is frequently deployed by someone who pastes their own
        log output into a ticket -- so nothing logs the real URL.
        """
        url = self.resolved_database_url
        scheme, sep, rest = url.partition("://")
        if not sep:
            return url
        userinfo, at, hostpart = rest.rpartition("@")
        if not at or ":" not in userinfo:
            return url
        username = userinfo.split(":", 1)[0]
        return f"{scheme}://{username}:***@{hostpart}"

    @property
    def origin_allowlist(self) -> set[str]:
        return {o.strip() for o in self.DEV_ORIGINS.split(",") if o.strip()}


class DatabaseConfigurationError(RuntimeError):
    """DATABASE_URL is missing, unparseable, or names an uninstalled driver."""


def resolve_database_url(config: Settings | None = None) -> str:
    """Validate DATABASE_URL and return it with an explicit driver.

    Called once from `app.db` at import time so a misconfigured deployment
    fails at boot with an actionable message instead of serving 500s. Never
    includes the password in the error text.
    """
    cfg = config or settings
    raw = (cfg.DATABASE_URL or "").strip()
    if not raw:
        raise DatabaseConfigurationError(
            "DATABASE_URL is empty. Set it in backend/.env, e.g. "
            "'DATABASE_URL=sqlite:///./data/marketingos.db' for local "
            "development or 'DATABASE_URL=postgresql+psycopg://USER:PASSWORD@HOST:5432/DB' "
            "in production."
        )
    if "://" not in raw:
        raise DatabaseConfigurationError(
            f"DATABASE_URL is not a URL (no '://' found). Expected "
            f"sqlite:///... or postgresql+psycopg://USER:PASSWORD@HOST:5432/DB. "
            f"Scheme seen: {cfg.database_scheme or '<none>'!r}."
        )
    if not (cfg.is_sqlite or cfg.is_postgresql):
        raise DatabaseConfigurationError(
            f"DATABASE_URL names an unsupported database "
            f"({cfg.database_scheme or '<none>'!r}). This project supports "
            f"'sqlite' (local development) and 'postgresql' (production)."
        )
    resolved = cfg.resolved_database_url
    if cfg.is_postgresql:
        driver = resolved.split("://", 1)[0].split("+", 1)[1] if "+" in resolved.split("://", 1)[0] else "psycopg"
        if driver == "psycopg2":
            raise DatabaseConfigurationError(
                "DATABASE_URL asks for the psycopg2 driver. This project uses "
                "psycopg 3 -- either install psycopg2-binary or, better, drop "
                "the driver from the URL: 'postgresql+psycopg://...'"
            )
    return resolved


@lru_cache
def get_settings() -> Settings:
    return Settings()


settings = get_settings()
