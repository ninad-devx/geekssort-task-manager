# MarketingOS

Internal marketing operations and work tracking: tasks, a time log driven by a
start/pause/override timer, role-specific dashboards, and a shared folder-and-link
workspace. One source of truth for what the team did, is doing, and is stuck on.

Built from SRS v1.0 (P0).

---

## Stack

| Layer | Choice |
|---|---|
| Backend | Python 3.12, FastAPI, Pydantic v2 + pydantic-settings, SQLAlchemy 2 (typed `Mapped[]`), Uvicorn, argon2-cffi, pytest, httpx |
| Frontend | Next.js 16 (App Router, strict TS), React 19, Tailwind CSS 4, shadcn-style components, TanStack Query, react-hook-form + zod, sonner, lucide-react, date-fns |
| Database | SQLite at `backend/data/marketingos.db`, WAL, foreign keys on, partial unique indexes |
| Runtime | Two processes (FastAPI, Next.js) behind one HTTPS reverse proxy |

No Docker, Redis, Celery or GraphQL. Distributions are CSS stacked bars — no chart library.

## Run it

Two terminals. From the repository root:

```bash
# 1. backend
cd backend
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
.venv/bin/python -m app.cli bootstrap-admin --email you@company.com --name "Your Name"
.venv/bin/python -m app.cli seed-defaults          # optional: the six default folders
.venv/bin/python -m uvicorn app.main:app --host 127.0.0.1 --port 8000

# 2. frontend
cd frontend
npm install
npm run dev -- --port 3000
```

Open <http://localhost:3000> and sign in as the admin you created.

`bootstrap-admin` refuses to run if any user already exists — use
`python -m app.cli reset-password --email you@company.com` to recover an account.

### Checks

```bash
cd backend  && .venv/bin/python -m pytest tests/ -q     # 102 gate tests
cd frontend && npm run lint && npx tsc --noEmit && npm run build
```

### Configuration

`backend/.env` (all optional; see `.env.example`):

| Variable | Default | Purpose |
|---|---|---|
| `APP_TIMEZONE` | `UTC` | company timezone for "today", due dates and daily totals |
| `COOKIE_SECURE` | `false` | set `true` behind HTTPS |
| `MAX_TIMER_HOURS` | `12` | a running timer older than this is flagged stale |
| `MAX_SESSION_HOURS` | `24` | hard cap on a single time entry |
| `MEMBER_CAN_CREATE_TASKS` | `true` | members may create tasks for themselves |
| `MEMBER_CAN_EDIT_TIME` | `true` | members may edit/delete their own entries |
| `TIME_EDIT_WINDOW_DAYS` | `0` | 0 means unlimited |
| `MEMBER_CAN_ADD_LINKS` | `true` | |
| `MEMBER_CAN_CREATE_FOLDERS` | `false` | |

## Architecture notes

**Authorization lives only on the server.** `backend/app/policy.py` plus router
dependencies decide everything. The frontend renders from server-supplied
`capabilities` and per-object `allowed_actions`; hiding a button is never the control.
Every request is re-checked regardless of what the UI showed.

**Object-level denial is a 404, not a 403** (D-10), so IDs cannot be enumerated. A
member who asks for someone else's task gets `TASK_NOT_FOUND`.

**Every write is one transaction containing the data change and its audit events.**
`app/db.py::write_tx` opens `BEGIN IMMEDIATE`; each request gets one `request_id` that
all of its events share.

**`audit_events` is append-only at the database level** — SQLite `BEFORE UPDATE` and
`BEFORE DELETE` triggers raise. There is no endpoint that modifies it. A correction is
a new event.

**Timers live on the server.** The client polls elapsed time from `started_at` against
the server-supplied `server_time`; it never keeps its own clock, and closing the browser
or signing out does not stop a timer. Exactly one running timer per user is guaranteed
by a partial unique index, not only by application code.

**Sessions are opaque server-side rows.** 32 random bytes in an `HttpOnly`,
`SameSite=Lax` cookie; only the SHA-256 hash is stored. They are revocable and
unreadable by page scripts.

**CSRF**: `SameSite=Lax` + an `Origin` check + a mandatory `X-Requested-With: marketingos`
header on every write. Same origin in production via a Next.js rewrite — no CORS middleware.

## Layout

```
backend/
  app/
    config.py      settings from the environment
    db.py          engine, WAL pragmas, write_tx
    models.py      typed SQLAlchemy models + enums
    policy.py      ALL authorization decisions
    workflow.py    the task status state machine
    timelog.py     start/pause/manual/edit/delete, validation, auto-close
    serializers.py allowed_actions + API shapes
    audit.py       the append-only event writer
    routers/       auth, users, tasks, logs, audit, dashboard, workspace
    cli.py         bootstrap-admin, reset-password, seed-defaults, backup
  tests/           102 gate tests
frontend/
  src/app/(app)/   protected pages
  src/components/  shell, timer bar, task UI, primitives
  src/lib/         api client, auth context, types, formatting
```

## Data model

`users` · `sessions` · `tasks` · `task_logs` (the work log; one row per timer segment
or note) · `audit_events` · `workspace_folders` · `resource_links` ·
`resource_link_tags`.

Tasks, logs, folders and links are soft-deleted. Users are deactivated, never deleted,
so history keeps their name.

## Out of scope for P0

File uploads, notifications, email/chat integration, CSV/PDF export, campaigns, content
calendar, CRM/leads, event management, competitor intelligence, analytics, payroll,
screenshots, keystroke or location monitoring, mobile apps. No screenshot or location
monitoring is ever collected — time is self-reported.