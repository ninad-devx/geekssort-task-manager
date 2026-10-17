# syntax=docker/dockerfile:1

# Single stage on purpose: every dependency here ships a manylinux wheel
# (argon2-cffi, pydantic-core, uvloop/httptools), so there is nothing to
# compile and a builder/runtime split would only add a copy step. If a future
# pin loses its wheel this fails loudly at build time instead of silently
# dragging in a compiler toolchain.
FROM python:3.12-slim AS runtime

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    VIRTUAL_ENV=/opt/venv \
    PATH="/opt/venv/bin:$PATH"

WORKDIR /app

# Requirements are copied and installed before the source so that editing app/
# reuses this cached layer. The venv lives at /opt/venv rather than inside /app
# so a bind-mounted source tree can never shadow it.
COPY requirements.txt ./
RUN python -m venv "$VIRTUAL_ENV" \
 && pip install --upgrade pip \
 && pip install -r requirements.txt

# app/config.py resolves BACKEND_DIR as <parent of app/> and app/db.py puts its
# state in BACKEND_DIR/data, so with the source at /app/app this is /app/data --
# where the SQLite file and the -wal/-shm sidecars that WAL mode creates land.
#
# This must be a volume at run time. Data baked into an image layer is lost on
# every container recreate, and SQLite specifically cannot live there: the file
# would be replaced wholesale while WAL sidecars from the old layer persisted.
RUN mkdir -p /app/data \
 && useradd --create-home --uid 10001 --shell /usr/sbin/nologin appuser \
 && chown -R appuser:appuser /app

COPY --chown=appuser:appuser app ./app

USER appuser

EXPOSE 8000

# urllib rather than curl: this base image has no HTTP client installed.
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD python -c "import urllib.request as u,sys; sys.exit(0 if u.urlopen('http://127.0.0.1:8000/api/health', timeout=2).status == 200 else 1)"

# --workers 1 is load-bearing, not a default. SQLite grants a single writer and
# the write path opens BEGIN IMMEDIATE (app/db.py), so a second worker shows up
# as intermittent "database is locked" under concurrency. Reach for more
# throughput by moving to Postgres or by running replicas against a shared
# volume, not by raising this number.
#
# --proxy-headers only makes uvicorn's own access log show the real client
# instead of nginx. It is NOT what the login rate limiter reads: app/deps.py
# client_ip() gates X-Forwarded-For behind TRUST_PROXY_HEADERS on its own. Keep
# 8000 unpublished so nothing but the reverse proxy can reach it.
CMD ["uvicorn", "app.main:app", \
     "--host", "0.0.0.0", \
     "--port", "8000", \
     "--workers", "1", \
     "--proxy-headers", \
     "--forwarded-allow-ips", "*"]
