"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  ArrowLeft,
  Calendar,
  Clock,
  ExternalLink,
  Gauge,
  History,
  Link2,
  Pencil,
  Plus,
  StickyNote,
  Trash2,
  Undo2,
  UserRoundCog,
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { use, useState } from "react";
import { toast } from "sonner";

import { PageHeader } from "@/components/app-shell";
import { Avatar } from "@/components/avatar";
import { useElapsed, useRunningTimer } from "@/components/timer-bar";
import {
  OverdueBadge,
  OtherRunners,
  PriorityBadge,
  StatusBadge,
  TimerActions,
  TrackedTime,
} from "@/components/tasks/task-ui";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, EmptyState, ErrorState, Spinner } from "@/components/ui/card";
import {
  Badge,
  ConfirmDialog,
  Dialog,
  Field,
  Input,
  Progress,
  Select,
  Textarea,
} from "@/components/ui/form";
import { api, ApiError, errorMessage, qs } from "@/lib/api";
import { useAuth, useDirectory } from "@/lib/auth";
import {
  formatDateTime,
  formatDuration,
  fromLocalInput,
  overdueDays,
  toLocalInput,
  todayLocal,
} from "@/lib/format";
import {
  EVENT_LABELS,
  STATUS_LABELS,
  type AuditEvent,
  type Folder,
  type ResourceLink,
  type Task,
  type TaskLog,
  type TaskStatus,
} from "@/lib/types";

type Tab = "log" | "history";

export default function TaskDetailPage({ params }: PageProps<"/tasks/[id]">) {
  const { id: rawId } = use(params);
  const id = Number(rawId);
  const router = useRouter();
  const client = useQueryClient();
  const { capabilities } = useAuth();
  const [tab, setTab] = useState<Tab>("log");
  const [dialog, setDialog] = useState<
    null | "add_time" | "note" | "status" | "assign" | "edit" | "link"
  >(null);

  const task = useQuery({
    queryKey: ["task", id],
    queryFn: () => api<Task>(`/tasks/${id}`),
    enabled: Number.isFinite(id),
  });

  const canSeeDeleted = !!capabilities?.can_view_team;
  const logs = useQuery({
    queryKey: ["logs", id, canSeeDeleted],
    queryFn: () =>
      api<TaskLog[]>(`/tasks/${id}/logs${qs({ include_deleted: canSeeDeleted })}`),
    enabled: Number.isFinite(id),
  });

  const history = useQuery({
    queryKey: ["audit", "task", id],
    queryFn: () => api<{ items: AuditEvent[] }>(`/audit${qs({ task_id: id, page_size: 100 })}`),
    enabled: Number.isFinite(id) && tab === "history",
  });

  const taskLinks = useQuery({
    queryKey: ["task", id, "links"],
    queryFn: () => api<ResourceLink[]>(`/tasks/${id}/links`),
    enabled: Number.isFinite(id),
  });

  const invalidate = () => client.invalidateQueries();

  if (task.isLoading) return <Spinner label="Loading task" />;
  if (task.isError) {
    return (
      <ErrorState
        message={
          task.error instanceof ApiError && task.error.status === 404
            ? "This task does not exist, or you do not have access to it."
            : "The task could not be loaded."
        }
        onRetry={() => void task.refetch()}
      />
    );
  }

  const t = task.data;
  if (!t) return <Spinner label="Loading task" />;
  const actions = t.allowed_actions;
  const today = todayLocal();
  const late = overdueDays(t.due_date, today);

  const changeStatus = async (status: TaskStatus, extra: Record<string, unknown> = {}) => {
    await api<Task>(`/tasks/${t.id}/status`, { method: "POST", json: { status, ...extra } });
    toast.success(`Moved to ${STATUS_LABELS[status]}`);
    await invalidate();
  };

  const remove = async () => {
    await api(`/tasks/${t.id}`, { method: "DELETE" });
    toast.success("Task deleted");
    // Invalidate before navigating. This went straight to `router.push`, so
    // `["tasks"]`, `["task", id]` and `["dashboard"]` still held the deleted
    // task and the destination list could render its row for up to the 15s
    // staleTime.
    await invalidate();
    router.push("/my-tasks");
  };

  const restore = async () => {
    await api(`/tasks/${t.id}/restore`, { method: "POST", json: {} });
    toast.success("Task restored");
    await invalidate();
  };

  return (
    <>
      {/*
        A breadcrumb. Arriving here from the by-person board, the browser Back
        button through a stack of filtered URLs used to be the only way out.
      */}
      <nav aria-label="Breadcrumb" className="mb-3 flex items-center gap-2 text-xs font-medium">
        <Link
          href="/my-tasks"
          className="inline-flex items-center gap-1.5 rounded-full border border-border/70 bg-card px-3 py-1 text-muted-foreground transition-colors hover:border-[#1f7a52]/40 hover:text-foreground"
        >
          <ArrowLeft className="h-3.5 w-3.5" aria-hidden />
          My tasks
        </Link>
        <span className="text-muted-foreground" aria-hidden>
          /
        </span>
        <span className="rounded-full bg-[#eaf4ef] px-2.5 py-0.5 font-semibold text-[#145338]">
          Task #{t.id}
        </span>
      </nav>

      <PageHeader
        title={t.title}
        description={t.assignee ? `Assigned to ${t.assignee.full_name}` : "Unassigned"}
        actions={
          <>
            {actions.includes("start_timer") || actions.includes("pause_timer") ? (
              <TimerActions task={t} onChanged={invalidate} size="default" />
            ) : null}
            {actions.includes("change_status") ? (
              <Button variant="outline" onClick={() => setDialog("status")}>
                Change status
              </Button>
            ) : null}
            {actions.includes("edit") ? (
              <Button variant="outline" onClick={() => setDialog("edit")}>
                <Pencil className="h-4 w-4" aria-hidden />
                Edit
              </Button>
            ) : null}
            {actions.includes("add_time") ? (
              <>
                <Button variant="outline" onClick={() => setDialog("add_time")}>
                  <Plus className="h-4 w-4" aria-hidden />
                  Add time
                </Button>
                <Button variant="outline" onClick={() => setDialog("note")}>
                  <StickyNote className="h-4 w-4" aria-hidden />
                  Note
                </Button>
              </>
            ) : null}
            {actions.includes("reassign") ? (
              <Button variant="outline" onClick={() => setDialog("assign")}>
                <UserRoundCog className="h-4 w-4" aria-hidden />
                Reassign
              </Button>
            ) : null}
            {actions.includes("delete") ? (
              <DeleteTaskButton onDelete={remove} />
            ) : null}
            {actions.includes("restore") ? (
              <Button variant="outline" onClick={() => void restore()}>
                <Undo2 className="h-4 w-4" aria-hidden />
                Restore
              </Button>
            ) : null}
          </>
        }
      />

      {/* Task KPI Summary Strip */}
      <div className="mb-5 grid gap-3.5 sm:grid-cols-2 lg:grid-cols-4">
        <div className="hero-green-card relative overflow-hidden rounded-2xl p-4 shadow-sm">
          <div className="flex items-start justify-between">
            <div>
              <p className="text-xs font-medium text-white/80">Tracked Time</p>
              <div className="mt-1.5 text-2xl font-bold tracking-tight text-white [&_span]:text-white">
                <TrackedTime seconds={t.tracked_seconds} />
              </div>
            </div>
            <span className="flex h-9 w-9 items-center justify-center rounded-full bg-white/15 text-white">
              <Clock className="h-4 w-4" aria-hidden />
            </span>
          </div>
          <p className="mt-2 text-[11px] font-medium text-white/75">
            {t.estimated_minutes
              ? `Estimated ${formatDuration(t.estimated_minutes * 60)}`
              : "No estimate set"}
          </p>
        </div>

        <div className="rounded-2xl border border-border/70 bg-card p-4 shadow-[0_1px_3px_rgba(15,23,42,0.03)]">
          <div className="flex items-start justify-between">
            <div>
              <p className="text-xs font-medium text-muted-foreground">Status & Priority</p>
              <div className="mt-2 flex flex-wrap items-center gap-1.5">
                <StatusBadge status={t.status} />
                <PriorityBadge priority={t.priority} />
              </div>
            </div>
          </div>
          <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
            {t.requires_review ? <Badge variant="warning">Requires review</Badge> : null}
            {t.deleted_at ? <Badge variant="danger">Deleted</Badge> : null}
            <OtherRunners task={t} />
            {!t.requires_review && !t.deleted_at && t.other_runners.length === 0 ? (
              <span className="text-[11px] text-muted-foreground">Current workflow stage</span>
            ) : null}
          </div>
        </div>

        <div className="rounded-2xl border border-border/70 bg-card p-4 shadow-[0_1px_3px_rgba(15,23,42,0.03)]">
          <div className="flex items-start justify-between">
            <div>
              <p className="text-xs font-medium text-muted-foreground">Completion Progress</p>
              <p className="tabular mt-1.5 text-2xl font-bold tracking-tight text-foreground">
                {t.progress_percent}%
              </p>
            </div>
            <span className="flex h-9 w-9 items-center justify-center rounded-full bg-[#eaf4ef] text-[#145338]">
              <Gauge className="h-4 w-4" aria-hidden />
            </span>
          </div>
          <div className="mt-2.5">
            <Progress value={t.progress_percent} />
          </div>
        </div>

        <div className="rounded-2xl border border-border/70 bg-card p-4 shadow-[0_1px_3px_rgba(15,23,42,0.03)]">
          <div className="flex items-start justify-between">
            <div>
              <p className="text-xs font-medium text-muted-foreground">Due Date</p>
              <p className="tabular mt-1.5 text-xl font-bold tracking-tight text-foreground">
                {t.due_date ?? "No deadline"}
              </p>
            </div>
            <span
              className={`flex h-9 w-9 items-center justify-center rounded-full ${
                late ? "bg-destructive/10 text-destructive" : "bg-[#eaf4ef] text-[#145338]"
              }`}
            >
              <Calendar className="h-4 w-4" aria-hidden />
            </span>
          </div>
          <div className="mt-2">
            {late ? (
              <OverdueBadge days={late} />
            ) : (
              <span className="text-[11px] text-muted-foreground">
                {t.category ? `Category: ${t.category.replace(/_/g, " ")}` : "Schedule target"}
              </span>
            )}
          </div>
        </div>
      </div>

      {t.blocked_reason ? (
        <Card className="mb-5 border-destructive/40 bg-destructive/[0.03]">
          <CardHeader>
            <div className="flex items-center gap-2">
              <AlertTriangle className="h-4 w-4 text-destructive" aria-hidden />
              <CardTitle className="text-destructive">Blocked</CardTitle>
            </div>
          </CardHeader>
          <CardContent>
            <p className="text-sm font-medium text-foreground">{t.blocked_reason}</p>
          </CardContent>
        </Card>
      ) : null}

      <div className="grid gap-5 lg:grid-cols-[1fr_340px]">
        <div className="flex flex-col gap-5">
          <Card>
            <CardHeader>
              <div className="flex items-center justify-between">
                <CardTitle>{tab === "log" ? "Work log" : "History"}</CardTitle>
                <div className="flex gap-1 rounded-full bg-muted p-1">
                  <TabButton active={tab === "log"} onClick={() => setTab("log")}>
                    Work log
                  </TabButton>
                  <TabButton active={tab === "history"} onClick={() => setTab("history")}>
                    <History className="h-3.5 w-3.5" aria-hidden />
                    History
                  </TabButton>
                </div>
              </div>
            </CardHeader>
            <CardContent>
              {tab === "log" ? (
                <LogList
                  logs={logs.data ?? []}
                  isLoading={logs.isLoading}
                  error={logs.error}
                  canSeeDeleted={canSeeDeleted}
                  onChanged={invalidate}
                />
              ) : (
                <HistoryList
                  events={history.data?.items ?? []}
                  isLoading={history.isLoading}
                  error={history.error}
                />
              )}
            </CardContent>
          </Card>
        </div>

        <aside className="flex flex-col gap-5">
          <Card>
            <CardHeader>
              <CardTitle>Details</CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-3.5 text-sm">
              {t.description ? (
                <div className="rounded-xl bg-muted/40 p-3 text-sm text-foreground/90">
                  <p className="whitespace-pre-wrap">{t.description}</p>
                </div>
              ) : null}
              <Detail label="Assignee">
                {t.assignee ? (
                  <div className="mt-1 flex items-center gap-2">
                    <Avatar person={t.assignee} size="xs" />
                    <span className="font-medium text-foreground">{t.assignee.full_name}</span>
                  </div>
                ) : (
                  <span className="text-muted-foreground">Unassigned</span>
                )}
              </Detail>
              <Detail label="Progress">
                <div className="flex items-center gap-2">
                  <Progress value={t.progress_percent} />
                  <span className="tabular text-xs font-semibold text-muted-foreground">
                    {t.progress_percent}%
                  </span>
                </div>
              </Detail>
              {t.category ? <Detail label="Category">{t.category.replace(/_/g, " ")}</Detail> : null}
              {t.due_date ? <Detail label="Due">{t.due_date}</Detail> : null}
              {t.estimated_minutes ? (
                <Detail label="Estimated">
                  {formatDuration(t.estimated_minutes * 60)}
                </Detail>
              ) : null}
              {t.expected_deliverable ? (
                <Detail label="Deliverable">{t.expected_deliverable}</Detail>
              ) : null}
              {t.evidence_url ? (
                <Detail label="Evidence">
                  <a
                    href={t.evidence_url}
                    target="_blank"
                    rel="noopener noreferrer nofollow"
                    className="inline-flex items-center gap-1.5 rounded-lg bg-[#eaf4ef] px-2.5 py-1 text-xs font-semibold text-[#145338] hover:underline"
                  >
                    <Link2 className="h-3.5 w-3.5" aria-hidden />
                    Open link
                    <ExternalLink className="h-3 w-3" aria-hidden />
                  </a>
                </Detail>
              ) : null}
              <Detail label="Links">
                <div className="flex flex-col gap-1.5">
                  {(taskLinks.data ?? []).length === 0 ? (
                    <span className="text-muted-foreground">None attached to this task</span>
                  ) : (
                    (taskLinks.data ?? []).map((link) => (
                      <a
                        key={link.id}
                        href={link.url}
                        target="_blank"
                        rel="noopener noreferrer nofollow"
                        className="inline-flex items-center gap-1.5 text-primary hover:underline"
                      >
                        <Link2 className="h-3.5 w-3.5 shrink-0" aria-hidden />
                        <span className="truncate font-medium">{link.title}</span>
                      </a>
                    ))
                  )}
                  {capabilities?.can_add_links ? (
                    <button
                      type="button"
                      className="mt-1 inline-flex w-fit items-center gap-1 rounded-full border border-border/70 px-2.5 py-1 text-xs font-medium text-muted-foreground transition-colors hover:border-[#1f7a52]/40 hover:text-foreground"
                      onClick={() => setDialog("link")}
                    >
                      <Plus className="h-3 w-3" aria-hidden />
                      Attach a link
                    </button>
                  ) : null}
                </div>
              </Detail>
              <div className="border-t border-border/60 pt-3">
                <div className="grid gap-2.5">
                  <Detail label="Created by">{t.created_by?.full_name ?? "—"}</Detail>
                  <Detail label="Created">{formatDateTime(t.created_at)}</Detail>
                  {t.completed_at ? (
                    <Detail label="Completed">{formatDateTime(t.completed_at)}</Detail>
                  ) : null}
                </div>
              </div>
            </CardContent>
          </Card>
        </aside>
      </div>

      {/*
        Each dialog is mounted only while it is open. They used to be rendered
        permanently, so their `useState` initialisers ran exactly once for the
        life of the page: after a save the task refetched and the fresh props
        changed underneath stale local state. Apply then compared a stale value
        against a fresh prop and stayed disabled, Reassign re-sent the previous
        assignee, and Edit kept re-sending every field.
      */}
      {dialog === "add_time" ? (
        <AddTimeDialog open onClose={() => setDialog(null)} taskId={t.id} onDone={invalidate} />
      ) : null}
      {dialog === "link" ? (
        <AttachLinkDialog open onClose={() => setDialog(null)} taskId={t.id} onDone={invalidate} />
      ) : null}
      {dialog === "note" ? (
        <NoteDialog open onClose={() => setDialog(null)} taskId={t.id} onDone={invalidate} />
      ) : null}
      {dialog === "status" ? (
        <StatusDialog
          open
          onClose={() => setDialog(null)}
          task={t}
          onSubmit={changeStatus}
        />
      ) : null}
      {dialog === "edit" ? (
        <EditTaskDialog open onClose={() => setDialog(null)} task={t} onDone={invalidate} />
      ) : null}
      {dialog === "assign" ? (
        <AssignDialog open onClose={() => setDialog(null)} task={t} onDone={invalidate} />
      ) : null}
    </>
  );
}

/**
 * A read-only term/definition pair.
 *
 * This rendered a `<label>` with no `for` and no form control inside it, which
 * is invalid and announces as an empty unlabelled field. It is a term, so it is
 * a term.
 */
function Detail({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <span className="text-[11px] font-semibold tracking-wider text-muted-foreground uppercase">
        {label}
      </span>
      <div className="mt-0.5">{children}</div>
    </div>
  );
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-semibold transition-colors ${
        active ? "bg-card text-foreground shadow-xs" : "text-muted-foreground hover:text-foreground"
      }`}
    >
      {children}
    </button>
  );
}

function DeleteTaskButton({ onDelete }: { onDelete: () => Promise<void> }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  return (
    <>
      <Button variant="outline" onClick={() => setOpen(true)}>
        <Trash2 className="h-4 w-4" aria-hidden />
        Delete
      </Button>
      <ConfirmDialog
        open={open}
        onClose={() => setOpen(false)}
        destructive
        confirmLabel="Delete task"
        title="Delete this task?"
        description="The task is soft-deleted: it disappears from lists and dashboards, but its log and history are kept."
        loading={busy}
        onConfirm={async () => {
          setBusy(true);
          try {
            await onDelete();
            setOpen(false);
          } catch (error) {
            toast.error(error instanceof ApiError ? error.message : "Could not delete");
          } finally {
            setBusy(false);
          }
        }}
      />
    </>
  );
}

// --- log list --------------------------------------------------------------

function LogList({
  logs,
  isLoading,
  error,
  canSeeDeleted,
  onChanged,
}: {
  logs: TaskLog[];
  isLoading: boolean;
  error: unknown;
  canSeeDeleted: boolean;
  onChanged: () => void;
}) {
  const [editing, setEditing] = useState<TaskLog | null>(null);
  const [deleting, setDeleting] = useState<TaskLog | null>(null);
  const [busy, setBusy] = useState(false);

  return (
    <>
      {/* Error is checked before emptiness. The old order reported a failed
          request as "No time recorded yet", which tells the user they have
          tracked nothing when the truth is that the request did not come back. */}
      {isLoading ? (
        <Spinner label="Loading log" />
      ) : error ? (
        <ErrorState
          message={error instanceof Error ? error.message : "Could not load the work log."}
          onRetry={onChanged}
        />
      ) : logs.length === 0 ? (
        <EmptyState
          title="No time recorded yet"
          description="Press Start to track time, or add an entry manually for something you forgot."
        />
      ) : (
        <ul className="flex flex-col divide-y divide-border/60">
          {logs.map((log) => (
            <LogRow
              key={log.id}
              log={log}
              canSeeDeleted={canSeeDeleted}
              onEdit={() => setEditing(log)}
              onDelete={() => setDeleting(log)}
            />
          ))}
        </ul>
      )}
      {/* Keyed by entry id so opening a different entry gets a clean form. */}
      {editing ? (
        <EditLogDialog key={editing.id} log={editing} onClose={() => setEditing(null)} onDone={onChanged} />
      ) : null}
      <ConfirmDialog
        open={deleting !== null}
        onClose={() => setDeleting(null)}
        destructive
        confirmLabel={deleting && deleting.ended_at === null ? "Discard timer" : "Delete entry"}
        loading={busy}
        title={
          deleting && deleting.ended_at === null
            ? "Discard this running timer?"
            : "Delete this time entry?"
        }
        description={
          deleting && deleting.ended_at === null
            ? "The timer is closed at its current elapsed time and removed from totals. This is recorded in the audit log."
            : "The entry is soft-deleted and removed from totals. Management can still see that it was deleted — this is recorded as an audit event."
        }
        onConfirm={async () => {
          if (!deleting) return;
          setBusy(true);
          try {
            await api(`/logs/${deleting.id}`, { method: "DELETE" });
            toast.success("Entry deleted");
            setDeleting(null);
            await onChanged();
          } catch (err) {
            toast.error(errorMessage(err));
          } finally {
            setBusy(false);
          }
        }}
      />
    </>
  );
}

function LogRow({
  log,
  canSeeDeleted,
  onEdit,
  onDelete,
}: {
  log: TaskLog;
  canSeeDeleted: boolean;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const timer = useRunningTimer();
  const mine = timer.data?.running ?? [];
  const elapsed = useElapsed(log.ended_at ? undefined : log.started_at, timer.data?.server_time);

  const isRunning = log.ended_at === null;
  const seconds = isRunning ? elapsed : (log.duration_seconds ?? 0);

  return (
    <li
      className={`flex flex-wrap items-start gap-3 py-3.5 ${log.deleted_at ? "opacity-60" : ""}`}
    >
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="tabular text-sm font-bold text-foreground">
            {isRunning ? formatDuration(Math.max(seconds, 0)) : formatDuration(seconds)}
          </span>
          <Badge variant={log.source === "timer" ? "default" : "outline"}>
            {log.source === "timer" ? "Timer" : log.entry_type === "note" ? "Note" : "Manual"}
          </Badge>
          {log.edit_count > 0 ? <Badge variant="warning">Edited ({log.edit_count})</Badge> : null}
          {log.deleted_at ? <Badge variant="danger">Deleted</Badge> : null}
          {isRunning && mine?.some((r) => r.log_id === log.id && r.is_stale) ? (
            <Badge variant="warning">Stale</Badge>
          ) : null}
        </div>
        <div className="mt-1 text-xs text-muted-foreground">
          {log.user?.full_name ?? "Unknown"} · {formatDateTime(log.started_at)}
          {!isRunning ? ` → ${formatDateTime(log.ended_at)}` : " → running"}
        </div>
        {log.note ? <p className="mt-1.5 text-sm text-foreground/90">{log.note}</p> : null}
        {log.progress_percent !== null ? (
          <p className="mt-1 text-xs text-muted-foreground">Progress set to {log.progress_percent}%</p>
        ) : null}
        {log.evidence_url ? (
          <a
            href={log.evidence_url}
            target="_blank"
            rel="noopener noreferrer nofollow"
            className="mt-1.5 inline-flex items-center gap-1 rounded-md bg-[#eaf4ef] px-2 py-0.5 text-xs font-medium text-[#145338] hover:underline"
          >
            <Link2 className="h-3 w-3" aria-hidden />
            Evidence
          </a>
        ) : null}
        {canSeeDeleted && log.deleted_at ? (
          <p className="mt-1 text-xs text-muted-foreground">
            Deleted {formatDateTime(log.deleted_at)}
          </p>
        ) : null}
      </div>
      {log.allowed_actions.includes("edit") ? (
        <Button variant="ghost" size="icon" onClick={onEdit} aria-label="Edit entry">
          <Pencil className="h-4 w-4" />
        </Button>
      ) : null}
      {log.allowed_actions.includes("delete") ? (
        <Button
          variant="ghost"
          size="icon"
          onClick={onDelete}
          aria-label={isRunning ? "Discard timer" : "Delete entry"}
        >
          <Trash2 className="h-4 w-4" />
        </Button>
      ) : null}
    </li>
  );
}

// --- history ---------------------------------------------------------------

function HistoryList({
  events,
  isLoading,
  error,
}: {
  events: AuditEvent[];
  isLoading: boolean;
  error: unknown;
}) {
  if (isLoading) return <Spinner label="Loading history" />;
  if (error) {
    return (
      <ErrorState
        message={error instanceof Error ? error.message : "Could not load the history."}
      />
    );
  }
  if (events.length === 0) {
    return <EmptyState title="No history yet" description="Every change to this task will appear here." />;
  }
  return (
    <ul className="flex flex-col gap-3">
      {events.map((event) => (
        <li key={event.id} className="border-b border-border/60 pb-3.5 last:border-b-0">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="outline">{EVENT_LABELS[event.event_type] ?? event.event_type}</Badge>
            <span className="text-xs text-muted-foreground">
              {event.actor_name} · {formatDateTime(event.created_at)}
            </span>
          </div>
          <p className="mt-1.5 text-sm font-medium text-foreground">{event.summary}</p>
          <DiffTable before={event.before} after={event.after} />
        </li>
      ))}
    </ul>
  );
}

function DiffTable({
  before,
  after,
}: {
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
}) {
  if (!before && !after) return null;
  const keys = Array.from(new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})])).filter(
    (key) => JSON.stringify(before?.[key]) !== JSON.stringify(after?.[key]),
  );
  if (keys.length === 0) return null;
  return (
    <div className="mt-2 overflow-hidden rounded-xl border border-border/60 bg-muted/30 px-3 py-2">
      <table className="w-full text-xs">
        <tbody>
          {keys.map((key) => (
            <tr key={key} className="align-top">
              <td className="w-32 py-0.5 pr-2 font-medium text-muted-foreground">{key}</td>
              <td className="py-0.5 pr-2 text-muted-foreground line-through">
                {renderValue(before?.[key])}
              </td>
              <td className="py-0.5 font-medium text-foreground">{renderValue(after?.[key])}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function renderValue(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

// --- dialogs ---------------------------------------------------------------

function AddTimeDialog({
  open,
  onClose,
  taskId,
  onDone,
}: {
  open: boolean;
  onClose: () => void;
  taskId: number;
  onDone: () => void;
}) {
  // Seeded at mount. This dialog used to be mounted permanently, so "now" was
  // captured when the *page* loaded: open it tomorrow and yesterday's
  // timestamps were already sitting in the form.
  const [startedAt, setStartedAt] = useState(toLocalInput(new Date().toISOString()));
  const [endedAt, setEndedAt] = useState(toLocalInput(new Date().toISOString()));
  const [note, setNote] = useState("");
  const [progress, setProgress] = useState("");
  const [evidence, setEvidence] = useState("");
  const [touched, setTouched] = useState(false);

  // Both fields defaulted to the same instant, which is a zero-length entry.
  // `Date.now()` is deliberately not called here: reading a clock during render
  // makes the component impure. The future check happens on submit instead.
  const startMs = startedAt ? new Date(startedAt).getTime() : NaN;
  const endMs = endedAt ? new Date(endedAt).getTime() : NaN;
  const missingTimes = !startedAt || !endedAt || Number.isNaN(startMs) || Number.isNaN(endMs);
  const backwards = !missingTimes && endMs <= startMs;
  const progressNumber = progress === "" ? null : Number(progress);
  const progressBad =
    progressNumber !== null &&
    (!Number.isFinite(progressNumber) || progressNumber < 0 || progressNumber > 100);

  const timeError = missingTimes
    ? "Both a start and an end time are required"
    : backwards
      ? "The end time must be after the start time"
      : undefined;
  const progressError = progressBad ? "Enter a number between 0 and 100" : undefined;

  const mutation = useMutation({
    mutationFn: () =>
      api(`/tasks/${taskId}/logs`, {
        method: "POST",
        json: {
          entry_type: "work_session",
          started_at: fromLocalInput(startedAt),
          ended_at: fromLocalInput(endedAt),
          note: note || null,
          progress_percent: progressNumber,
          evidence_url: evidence || null,
        },
      }),
    onSuccess: async () => {
      toast.success("Time added");
      onClose();
      await onDone();
    },
    onError: (error) => toast.error(errorMessage(error)),
  });

  const [futureError, setFutureError] = useState(false);

  const submit = () => {
    setTouched(true);
    if (missingTimes || backwards || progressBad) return;
    if (!Number.isNaN(endMs) && endMs > Date.now()) {
      setFutureError(true);
      return;
    }
    mutation.mutate();
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Add time manually"
      description="For work you forgot to time. The entry is checked for overlaps."
      onSubmit={submit}
      submitLabel="Add entry"
      submitting={mutation.isPending}
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Started" required error={touched ? timeError : undefined}>
          <Input type="datetime-local" value={startedAt} onChange={(e) => setStartedAt(e.target.value)} />
        </Field>
        <Field
          label="Ended"
          required
          error={
            touched
              ? futureError
                ? "The end time cannot be in the future"
                : !missingTimes && !backwards
                  ? timeError
                  : undefined
              : undefined
          }
        >
          <Input
            type="datetime-local"
            value={endedAt}
            onChange={(e) => {
              setFutureError(false);
              setEndedAt(e.target.value);
            }}
          />
        </Field>
        <Field
          label="Progress %"
          hint="Optional"
          error={touched ? progressError : undefined}
        >
          <Input
            type="number"
            min={0}
            max={100}
            value={progress}
            onChange={(e) => setProgress(e.target.value)}
          />
        </Field>
        <Field label="Evidence URL" hint="Optional, http(s) only">
          <Input
            type="url"
            value={evidence}
            onChange={(e) => setEvidence(e.target.value)}
            placeholder="https://…"
          />
        </Field>
        <div className="sm:col-span-2">
          <Field label="Note" hint="Optional">
            <Textarea value={note} onChange={(e) => setNote(e.target.value)} maxLength={2000} />
          </Field>
        </div>
      </div>
    </Dialog>
  );
}

function NoteDialog({
  open,
  onClose,
  taskId,
  onDone,
}: {
  open: boolean;
  onClose: () => void;
  taskId: number;
  onDone: () => void;
}) {
  const [note, setNote] = useState("");
  const [evidence, setEvidence] = useState("");

  const mutation = useMutation({
    mutationFn: () =>
      api(`/tasks/${taskId}/logs`, {
        method: "POST",
        json: {
          entry_type: "note",
          started_at: fromLocalInput(new Date().toISOString()),
          note,
          evidence_url: evidence || null,
        },
      }),
    onSuccess: async () => {
      toast.success("Note added");
      setNote("");
      setEvidence("");
      onClose();
      await onDone();
    },
    onError: (error) =>
      toast.error(error instanceof ApiError ? error.message : "Could not add the note"),
  });

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Add a note"
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={() => mutation.mutate()} loading={mutation.isPending} disabled={!note.trim()}>
            Add note
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <Field label="Note">
          <Textarea value={note} onChange={(e) => setNote(e.target.value)} maxLength={2000} />
        </Field>
        <Field label="Evidence URL" hint="Optional">
          <Input value={evidence} onChange={(e) => setEvidence(e.target.value)} />
        </Field>
      </div>
    </Dialog>
  );
}

function AttachLinkDialog({
  open,
  onClose,
  taskId,
  onDone,
}: {
  open: boolean;
  onClose: () => void;
  taskId: number;
  onDone: () => void;
}) {
  const [title, setTitle] = useState("");
  const [url, setUrl] = useState("");
  const [folderId, setFolderId] = useState("");
  const [touched, setTouched] = useState(false);

  const folders = useQuery({
    queryKey: ["folders"],
    queryFn: () => api<Folder[]>(`/workspace/folders`),
    enabled: open,
  });

  // The hint promised http(s) only but nothing checked, so a `javascript:`
  // value was accepted and rendered as a live link.
  const urlError = (() => {
    if (!touched || !url.trim()) return undefined;
    if (!/^https?:\/\/.+/i.test(url.trim())) return "Must start with http:// or https://";
    return undefined;
  })();

  const mutation = useMutation({
    mutationFn: () =>
      api<ResourceLink>("/workspace/links", {
        method: "POST",
        json: {
          task_id: taskId,
          folder_id: folderId ? Number(folderId) : null,
          title: title.trim(),
          url: url.trim(),
        },
      }),
    onSuccess: async () => {
      toast.success("Link attached");
      onClose();
      await onDone();
    },
    onError: (error) => toast.error(errorMessage(error)),
  });

  const submit = () => {
    setTouched(true);
    if (!title.trim() || !url.trim() || urlError) return;
    mutation.mutate();
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Attach a link to this task"
      description="Reference material, a draft, a live campaign — anything this task should point at."
      onSubmit={submit}
      submitLabel="Attach"
      submitting={mutation.isPending}
    >
      <div className="flex flex-col gap-4">
        <Field label="Title" required error={touched && !title.trim() ? "Give the link a title" : undefined}>
          <Input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} />
        </Field>
        <Field label="URL" required error={urlError} hint="Must start with http:// or https://">
          <Input
            type="url"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://…"
          />
        </Field>
        <Field label="Also file in a workspace folder" hint="Optional">
          <Select value={folderId} onChange={(e) => setFolderId(e.target.value)}>
            <option value="">Task only</option>
            {(folders.data ?? []).map((folder) => (
              <option key={folder.id} value={folder.id}>
                {folder.name}
              </option>
            ))}
          </Select>
        </Field>
      </div>
    </Dialog>
  );
}

function EditLogDialog({
  log,
  onClose,
  onDone,
}: {
  log: TaskLog | null;
  onClose: () => void;
  onDone: () => void;
}) {
  // Loaded straight from the entry being edited. The dialog used to open blank
  // behind a "Load values" button, and because it stayed mounted its state
  // survived a close: open entry A, load, cancel, open entry B, and the form
  // still held A's timestamps. Saving then overwrote B with A's data.
  const [startedAt, setStartedAt] = useState(() => toLocalInput(log?.started_at));
  const [endedAt, setEndedAt] = useState(() =>
    log?.ended_at ? toLocalInput(log.ended_at) : "",
  );
  const [note, setNote] = useState(() => log?.note ?? "");
  const [reason, setReason] = useState("");
  const [touched, setTouched] = useState(false);

  const isRunning = log?.ended_at === null;
  const originalEnd = log?.ended_at ?? null;

  const startMs = startedAt ? new Date(startedAt).getTime() : NaN;
  const endMs = endedAt ? new Date(endedAt).getTime() : NaN;
  const missing = !startedAt || Number.isNaN(startMs);
  const endInvalid =
    !isRunning && (!endedAt || Number.isNaN(endMs) || endMs <= startMs);
  const timeError = missing
    ? "A start time is required"
    : endInvalid
      ? "The end time must be after the start time"
      : undefined;

  const mutation = useMutation({
    mutationFn: () => {
      if (!log) return Promise.resolve();
      const body: Record<string, unknown> = {
        started_at: fromLocalInput(startedAt),
        note,
        edit_reason: reason || null,
      };
      if (originalEnd && endedAt) {
        body.ended_at = fromLocalInput(endedAt);
        // This token exists to say "I mean it, change the end time". It was
        // hardcoded to true, so every end-time edit was either swallowed or
        // reported as a conflict. Set it from whether the value actually moved.
        body.if_ended_at_unchanged = endedAt === toLocalInput(originalEnd);
      }
      return api(`/logs/${log.id}`, { method: "PATCH", json: body });
    },
    onSuccess: async () => {
      toast.success("Entry updated — the change is recorded in the history");
      onClose();
      await onDone();
    },
    onError: (error) => toast.error(errorMessage(error)),
  });

  const submit = () => {
    setTouched(true);
    if (!log || timeError) return;
    mutation.mutate();
  };

  return (
    <Dialog
      open={log !== null}
      onClose={onClose}
      title="Edit time entry"
      description="Your change is audited with the values before and after."
      onSubmit={submit}
      submitLabel="Save"
      submitting={mutation.isPending}
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Started" required error={touched ? timeError : undefined}>
          <Input
            type="datetime-local"
            value={startedAt}
            onChange={(e) => setStartedAt(e.target.value)}
          />
        </Field>
        <Field
          label="Ended"
          hint={isRunning ? "A running timer is closed with Pause, not here." : undefined}
          error={touched && !missing ? timeError : undefined}
        >
          <Input
            type="datetime-local"
            value={endedAt}
            disabled={isRunning}
            onChange={(e) => setEndedAt(e.target.value)}
          />
        </Field>
        <div className="sm:col-span-2">
          <Field label="Note" hint="Leave empty to clear it">
            <Textarea value={note} onChange={(e) => setNote(e.target.value)} maxLength={2000} />
          </Field>
        </div>
        <div className="sm:col-span-2">
          <Field label="Reason for the edit" hint="Optional, up to 200 characters">
            <Input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={200} />
          </Field>
        </div>
      </div>
    </Dialog>
  );
}

function StatusDialog({
  open,
  onClose,
  task,
  onSubmit,
}: {
  open: boolean;
  onClose: () => void;
  task: Task;
  onSubmit: (status: TaskStatus, extra: Record<string, unknown>) => Promise<void>;
}) {
  const [status, setStatus] = useState<TaskStatus>(task.status);
  const [reason, setReason] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [touched, setTouched] = useState(false);

  const needsReason = status === "blocked";
  const needsNote =
    (task.status === "completed" && status === "in_progress") ||
    (task.status === "in_review" && status === "in_progress");

  // Both hints were promises with nothing behind them. Apply was gated only on
  // "did the status change", so "At least 3 characters" and "Required for this
  // transition" could both be ignored and the server would reject the save.
  const reasonError =
    needsReason && touched && reason.trim().length < 3
      ? "Give at least 3 characters explaining what is blocking this"
      : undefined;
  const noteError =
    needsNote && touched && !note.trim() ? "This transition needs a short note" : undefined;
  const blocked = Boolean(reasonError || noteError);

  const submit = async () => {
    setTouched(true);
    if (blocked || status === task.status) return;
    setBusy(true);
    try {
      await onSubmit(status, {
        reason: needsReason ? reason : null,
        note: note || null,
      });
      onClose();
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Change status"
      onSubmit={submit}
      submitLabel="Apply"
      submitting={busy}
    >
      <div className="flex flex-col gap-4">
        <Field label="New status">
          <Select value={status} onChange={(e) => setStatus(e.target.value as TaskStatus)}>
            {(Object.keys(STATUS_LABELS) as TaskStatus[]).map((value) => (
              <option key={value} value={value}>
                {STATUS_LABELS[value]}
              </option>
            ))}
          </Select>
        </Field>
        {needsReason ? (
          <Field
            label="Why is it blocked?"
            required
            error={reasonError}
            hint="At least 3 characters. Also saved as a log note."
          >
            <Textarea value={reason} onChange={(e) => setReason(e.target.value)} maxLength={2000} />
          </Field>
        ) : null}
        {needsNote || note.length > 0 || status !== task.status ? (
          <Field
            label="Note"
            required={needsNote}
            error={noteError}
            hint={needsNote ? "Required for this transition." : "Optional"}
          >
            <Textarea value={note} onChange={(e) => setNote(e.target.value)} maxLength={2000} />
          </Field>
        ) : null}
      </div>
    </Dialog>
  );
}

function EditTaskDialog({
  open,
  onClose,
  task,
  onDone,
}: {
  open: boolean;
  onClose: () => void;
  task: Task;
  onDone: () => void;
}) {
  const [form, setForm] = useState({
    title: task.title,
    description: task.description ?? "",
    priority: task.priority,
    due_date: task.due_date ?? "",
    category: task.category ?? "",
    expected_deliverable: task.expected_deliverable ?? "",
    estimated_minutes: task.estimated_minutes?.toString() ?? "",
    progress_percent: task.progress_percent.toString(),
    evidence_url: task.evidence_url ?? "",
  });
  const [touched, setTouched] = useState(false);

  // `Number("abc")` is NaN and `JSON.stringify({progress_percent: NaN})` is
  // `null`, so a typo silently sent "clear the progress" instead of the number
  // the field showed.
  const progressNumber = Number(form.progress_percent);
  const progressBad =
    form.progress_percent !== "" &&
    (!Number.isFinite(progressNumber) || progressNumber < 0 || progressNumber > 100);
  const titleError = touched && !form.title.trim() ? "A title is required" : undefined;

  const mutation = useMutation({
    mutationFn: () => {
      const body: Record<string, unknown> = { if_version: task.version };
      if (form.title !== task.title) body.title = form.title;
      if (form.description !== (task.description ?? "")) body.description = form.description || null;
      if (form.priority !== task.priority) body.priority = form.priority;
      if (form.due_date !== (task.due_date ?? "")) body.due_date = form.due_date || null;
      if (form.category !== (task.category ?? "")) body.category = form.category || null;
      if (form.expected_deliverable !== (task.expected_deliverable ?? ""))
        body.expected_deliverable = form.expected_deliverable || null;
      if (form.estimated_minutes !== (task.estimated_minutes?.toString() ?? ""))
        body.estimated_minutes = form.estimated_minutes ? Number(form.estimated_minutes) : null;
      if (Number.isFinite(progressNumber) && progressNumber !== task.progress_percent)
        body.progress_percent = progressNumber;
      if (form.evidence_url !== (task.evidence_url ?? "")) body.evidence_url = form.evidence_url || null;
      return api(`/tasks/${task.id}`, { method: "PATCH", json: body });
    },
    onSuccess: async () => {
      toast.success("Task updated");
      onClose();
      await onDone();
    },
    onError: (error) => toast.error(errorMessage(error)),
  });

  const set = (key: keyof typeof form) => (event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) =>
    setForm((prev) => ({ ...prev, [key]: event.target.value }));

  const submit = () => {
    setTouched(true);
    if (titleError || progressBad) return;
    mutation.mutate();
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Edit task"
      onSubmit={submit}
      submitLabel="Save changes"
      submitting={mutation.isPending}
    >
      <div className="flex flex-col gap-4">
        <Field label="Title" required error={titleError}>
          <Input value={form.title} onChange={set("title")} maxLength={200} />
        </Field>
        <Field label="Description">
          <Textarea value={form.description} onChange={set("description")} maxLength={5000} />
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Priority">
            <Select value={form.priority} onChange={set("priority")}>
              {(["low", "medium", "high", "urgent"] as const).map((value) => (
                <option key={value} value={value}>
                  {value}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Due date">
            <Input type="date" value={form.due_date} onChange={set("due_date")} />
          </Field>
          <Field label="Category">
            <Input value={form.category} onChange={set("category")} />
          </Field>
          <Field label="Estimated minutes">
            <Input
              type="number"
              min={1}
              value={form.estimated_minutes}
              onChange={set("estimated_minutes")}
            />
          </Field>
          <Field
            label="Progress %"
            error={progressBad ? "Enter a number between 0 and 100" : undefined}
          >
            <Input
              type="number"
              min={0}
              max={100}
              value={form.progress_percent}
              onChange={set("progress_percent")}
            />
          </Field>
          <Field label="Evidence URL" hint="http(s) only">
            <Input
              type="url"
              value={form.evidence_url}
              onChange={set("evidence_url")}
              placeholder="https://…"
            />
          </Field>
        </div>
        <Field label="Expected deliverable">
          <Input value={form.expected_deliverable} onChange={set("expected_deliverable")} maxLength={500} />
        </Field>
      </div>
    </Dialog>
  );
}

function AssignDialog({
  open,
  onClose,
  task,
  onDone,
}: {
  open: boolean;
  onClose: () => void;
  task: Task;
  onDone: () => void;
}) {
  const directory = useDirectory();
  const [assigneeId, setAssigneeId] = useState("");

  const mutation = useMutation({
    mutationFn: () =>
      api(`/tasks/${task.id}/assign`, {
        method: "POST",
        json: { assignee_id: Number(assigneeId) },
      }),
    onSuccess: async () => {
      toast.success("Task reassigned");
      onClose();
      await onDone();
    },
    onError: (error) => toast.error(errorMessage(error)),
  });

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Reassign task"
      description="Any running timer on this task is closed and the previous assignee keeps their log entries."
      onSubmit={() => assigneeId && mutation.mutate()}
      submitLabel="Reassign"
      submitting={mutation.isPending}
      submitDisabled={!assigneeId}
    >
      <Field
        label="Assignee"
        hint={
          task.assignee
            ? `Currently ${task.assignee.full_name}.`
            : "This task has no assignee yet."
        }
      >
        <Select value={assigneeId} onChange={(e) => setAssigneeId(e.target.value)}>
          <option value="">Choose a person…</option>
          {(directory.data ?? [])
            .filter((entry) => entry.is_active && entry.id !== task.assignee_id)
            .map((entry) => (
              <option key={entry.id} value={entry.id}>
                {entry.full_name}
              </option>
            ))}
        </Select>
      </Field>
    </Dialog>
  );
}