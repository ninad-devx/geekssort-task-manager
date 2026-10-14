# DECISIONS

Choices made where SRS v1.0 is silent. Rule 1 of the agent operating brief: where the
document is silent, take the simplest option consistent with it and record it here.

Sections 11–13 of the SRS (data model, UI, enums, event catalogue) were not supplied
with the build brief. The choices below fill those gaps.

---

## Enums and catalogues (filling SRS 13.2 / 13.3)

| ID | Decision |
|---|---|
| X-01 | Task status values are `todo`, `in_progress`, `blocked`, `in_review`, `completed`, exactly as named in the 10.2 state machine. |
| X-02 | Priority values are `low`, `medium`, `high`, `urgent` — the four priorities required by 5.1, ordered ascending. `urgent` is distinct from `high`. |
| X-03 | Folder visibility values are `all` and `management`, as named in FR-WS-003. |
| X-04 | `entry_type` values are `work_session` and `note`; `source` values are `timer` and `manual`. Named in FR-TIME-003, FR-TIME-008 and FR-TIME-012. |
| X-05 | Event types use a dotted `entity.action` form (`task.created`, `timer.paused`, `log.edited`, `user.deactivated`, `folder.moved`, `link.created`, …). The names required in 10.2 and FR-TIME are used verbatim. Where the SRS does not name an event, the nearest dotted form was chosen. |
| X-06 | Task categories are a free string column with a suggested list in the UI (`content`, `social_media`, `campaign`, `leads_outreach`, `events`, `competitor_research`, `company_resources`, `other`). A fixed enum would block the workspace categories the previous team's tracker used. |

## Tables (filling SRS 11)

| ID | Decision |
|---|---|
| X-07 | `task_logs` is the work log (D-05). A `work_session` row is one timer segment; pause closes it, resume opens a new one. Notes are rows in the same table with `entry_type='note'`, so a task's log is one chronological list. |
| X-08 | Link tags are rows in `resource_link_tags`, not a JSON column (D-16). |
| X-09 | `audit_events` stores `before_json` / `after_json` / `meta_json` as TEXT columns holding JSON, so before/after values are queryable without a JSON extension. |
| X-10 | Folders carry a denormalised `depth` column (max 6) so nesting is a single read. |
| X-11 | Sessions, links and folders use a nullable `deleted_by_id`; tasks additionally use `deleted_at` + `deleted_by_id` as FR-TASK-008 requires. |

## Authorization

| ID | Decision |
|---|---|
| X-12 | When both `CANNOT_EDIT_SELF` and `LAST_ADMIN` apply to an admin editing themself, `LAST_ADMIN` is returned first: the last-admin invariant holds regardless of who is asking. Both are 409. |
| X-13 | A 403 is used when the caller's *role* does not permit the endpoint at all (`LEAD_ONLY`, `ADMIN_ONLY`, `CANNOT_CREATE_FOLDERS`). A 404 is used when the object exists but the caller may not see it (D-10). A visible object the caller may see but not modify — for example a workspace link they do not own — returns 403 `CANNOT_EDIT_LINK`, because a misleading 404 would hide a real permission distinction. |
| X-14 | Restore is lead-only (7.2), so a member calling it gets 403 `LEAD_ONLY`. The task itself is invisible to them and returns 404 on read. |
| X-15 | `allowed_actions` is computed in `app/serializers.py` for every task and log returned by the API, so the UI never has to re-derive permissions (FR-TASK-004). |
| X-16 | `GET /auth/me` is the single source of capabilities. It is exempt from the `must_change_password` gate along with `/auth/change-password` and `/auth/logout` (FR-AUTH-006). |

## API shape

| ID | Decision |
|---|---|
| X-17 | All routes live under `/api`. Next.js rewrites `/api/*` to FastAPI, so the browser only ever talks to one origin (D-03). |
| X-18 | `request_id` is generated per request and returned in the `X-Request-Id` response header and on every audit event, so a user can correlate the history lines produced by one action (FR-AUDIT-002). |
| X-19 | Errors are always `{"detail": {"code": "...", "message": "...", ...extra}}`. The `code` is stable and machine-readable; extra fields carry specifics such as `conflicting_log_id`, `open_task_count` or `fields`. |
| X-20 | `GET /timer/current` returns the caller's running timer plus `server_time`. The UI measures elapsed time from `started_at` against that value (D-15). |
| X-21 | Timer pause accepts an optional `ended_at`. More than 60 s from the server clock sets `adjusted=true` on the response and on the audit event (FR-TIME-003). A supplied end time in the future is clamped to now rather than rejected, so a client clock that runs fast never loses an entry. |
| X-22 | `POST /tasks/{id}/logs` handles both manual sessions and notes, chosen by `entry_type` (FR-TIME-008, FR-TIME-012). |
| X-23 | Editing a running entry's `ended_at` returns 409 `USE_PAUSE`; the only way to close a running timer is to pause it or discard it (FR-TIME-009). |
| X-24 | The edit-window and `MEMBER_CAN_EDIT_TIME` switches are enforced in `timelog.edit` and `timelog.delete`, so every call path is covered. |

## Data and integrity

| ID | Decision |
|---|---|
| X-25 | A partial unique index `uq_running_session_per_user` on `task_logs(user_id) WHERE ended_at IS NULL` is the real guarantee of one running timer per user. The application check exists too, but a race returns the database error rather than two timers (FR-TIME-005). |
| X-26 | A partial unique index on `(parent_id, name) WHERE deleted_at IS NULL` enforces sibling folder uniqueness. Matching is case-insensitive via a `lower(name)` lookup in the router, since SQLite's default collation is case-sensitive. |
| X-27 | `task_logs` carries a CHECK that `ended_at >= started_at`. Notes set both to the same instant. |
| X-28 | Deleting a user closes their running timers, reassigns open tasks in the same transaction (each with its own `task.assigned` event) and deletes all their sessions, so their next request is a 401 (FR-USER-004, FR-AUTH-009). |
| X-29 | A session's day bucket is the calendar day of `started_at` in `APP_TIMEZONE`, computed server-side; the client never buckets dates (FR-TIME-015). |

## Frontend

| ID | Decision |
|---|---|
| X-30 | All authenticated pages live in the `src/app/(app)` route group behind one server-side gate. Following the Next.js App Router authentication guide, the gate is a Data Access Layer (`src/lib/dal.ts`) that reads the HttpOnly cookie with `cookies()`, calls `/api/auth/me`, and issues `redirect('/login')` when there is no session. The route group keeps URLs flat while giving one gate (FR-AUTH-012). |
| X-30b | The session is resolved on the server and seeded into the TanStack Query cache, so the client context never fetches it on mount. An earlier client-side effect gate compared `queryClient.getQueryData(['session'])` against `undefined` to detect "still loading"; when the query *errored* with 401 the cache was also `undefined`, so the redirect never fired and the UI sat on "Checking your session" forever. A server redirect cannot deadlock this way. |
| X-30c | The server gate also redirects to `/change-password` while `must_change_password` is true, rather than letting protected pages render and fail with 403 on every API call. |
| X-30d | `/change-password` resolves the session on the server too. It sits outside the `(app)` group, so it was rendering with no seeded session and `useAuth().user` was `null`: the forced-change branch therefore never rendered its "Sign out" button, and the only control shown was "Cancel", which pushed back to a route that redirected straight to `/change-password` again. An account created by an admin could not sign out or switch accounts. It now resolves `getSession()`, redirects to `/login` when signed out, and always offers "Sign in with a different account". |
| X-31 | The `/403` page sits inside the protected group: it is for a signed-in user whose role is insufficient. An unauthenticated visitor is sent to `/login`. `/login` is itself server-rendered and redirects an already-signed-in visitor to `/` (or `/change-password`). |
| X-32 | shadcn/ui components are vendored under `src/components/ui/` (button, card, form primitives, dialog, badge, progress) rather than pulled through the CLI, so the build has no interactive dependency. They follow shadcn conventions. |
| X-33 | TanStack Query owns all server state; `invalidateQueries()` after every mutation refreshes the task, its logs, the timer and the affected dashboards together, so totals can never drift between views. |
| X-34 | Dashboard and list queries refetch every 60 s and on window focus, and refetch on `visibilitychange` (FR-DASH-007). No polling continues while the tab is hidden. |
| X-35 | Elapsed time is computed in the browser from `started_at` minus the server's `server_time`, re-synced every second. The browser never keeps its own notion of "now" for timers (D-15). |
| X-36 | `POST /api/auth/logout` clears the session cookie and the query cache, then routes to `/login` in-app rather than doing a full page reload. |
| X-37 | TypeScript types are hand-written in `src/lib/types.ts` and checked against the live OpenAPI document by `npm run gen:api` (`openapi-typescript`), which is wired into the scripts. |

## Scope held back from P0

| ID | Decision |
|---|---|
| X-38 | `note` created as a side effect of a status transition (blocked reason, review feedback, reopen note) is written to the log. This is FR-TASK-012's "also written as a log note" and 10.2's "feedback saved as a log note by the reviewer". |
| X-39 | Audit retention is indefinite and nothing purges logs in P0 (FR-AUDIT-005, 10.4). |
| X-40 | No data migration tool ships. The schema is created by `init_db()`; Alembic is available for later migrations but P0 has no versioned upgrade path. |