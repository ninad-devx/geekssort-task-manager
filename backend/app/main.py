from __future__ import annotations

from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from app import audit
from app.config import settings
from app.db import engine, init_db, wait_for_database
from app.deps import enforce_csrf, set_request_context
from app.errors import AppError
from app.routers import audit as audit_router
from app.routers import auth, categories, dashboard, logs, notifications, permissions, tasks, users, workspace


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Prove the database answers before the first request is served. With
    # DB_CONNECT_WAIT_SECONDS=0 (the default, and what Compose should use) this
    # is a single ping, so a wrong host or password aborts the boot with the
    # driver's own error instead of surfacing as a 500 later -- and it never
    # falls back to SQLite.
    wait_for_database()
    init_db()
    try:
        yield
    finally:
        # Release every pooled connection on shutdown rather than waiting for
        # the process to be killed. `restart: unless-stopped` sends SIGTERM,
        # so this is the code path that actually runs on every deploy.
        engine.dispose()


app = FastAPI(
    title="Taskssort API",
    version="1.0.0",
    lifespan=lifespan,
    docs_url="/api/docs",
    openapi_url="/api/openapi.json",
)

# D-03: the browser only ever talks to one origin -- Next.js rewrites /api/* to this
# process -- so production needs no CORS at all and this middleware stays dormant.
# Registered unconditionally anyway: it is what answers a dev preflight, and it is
# what stops a stray cross-origin caller if port 8000 is ever exposed. Only the
# origins in DEV_ORIGINS (localhost unless you widen it) are ever echoed back.
app.add_middleware(
    CORSMiddleware,
    allow_origins=sorted(settings.origin_allowlist),
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.middleware("http")
async def request_context(request: Request, call_next):
    set_request_context(request)
    try:
        enforce_csrf(request)
    except AppError as exc:
        return JSONResponse(status_code=exc.status_code, content={"detail": exc.detail})
    response = await call_next(request)
    response.headers["X-Request-Id"] = audit.current_request_id()
    return response


@app.exception_handler(AppError)
async def app_error_handler(_request: Request, exc: AppError):
    return JSONResponse(status_code=exc.status_code, content={"detail": exc.detail})


@app.exception_handler(RequestValidationError)
async def validation_handler(_request: Request, exc: RequestValidationError):
    return JSONResponse(
        status_code=422,
        content={"detail": {"code": "VALIDATION_ERROR", "message": "Request validation failed", "errors": exc.errors()}},
    )


for r in (auth.router, users.router, tasks.router, logs.router, audit_router.router, dashboard.router, workspace.router, permissions.router, notifications.router, categories.router):
    app.include_router(r, prefix="/api")


@app.get("/api/health")
def health():
    # `database` is the point of this endpoint for an operator: it is the one
    # place that proves which engine the process actually connected to, so a
    # misconfigured DATABASE_URL cannot hide behind a container that is merely
    # "up". `database_url` is the redacted form -- see settings.safe_database_url.
    return {
        "status": "ok",
        "app_timezone": settings.APP_TIMEZONE,
        "database": settings.database_scheme,
        "database_url": settings.safe_database_url,
    }
