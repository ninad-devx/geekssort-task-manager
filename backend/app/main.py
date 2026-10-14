from __future__ import annotations

from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from app import audit
from app.config import settings
from app.db import init_db
from app.deps import enforce_csrf, set_request_context
from app.errors import AppError
from app.routers import audit as audit_router
from app.routers import auth, categories, dashboard, logs, notifications, permissions, tasks, users, workspace


@asynccontextmanager
async def lifespan(app: FastAPI):
    init_db()
    yield


app = FastAPI(
    title="MarketingOS API",
    version="1.0.0",
    lifespan=lifespan,
    docs_url="/api/docs",
    openapi_url="/api/openapi.json",
)

# D-03: no CORS middleware in production. Only the dev origins are allowed, and only for
# the explicit local dev ports listed in DEV_ORIGINS.
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
    return {"status": "ok", "app_timezone": settings.APP_TIMEZONE}