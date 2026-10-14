"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  History,
  Link2,
  Pencil,
  Plus,
  StickyNote,
  Trash2,
  Undo2,
  UserRoundCog,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { use, useState } from "react";
import { toast } from "sonner";

import { PageHeader } from "@/components/app-shell";
import { useElapsed, useRunningTimer } from "@/components/timer-bar";
import {
  OverdueBadge,
  PriorityBadge,
  StatusBadge,
  TimerActions,
  TrackedTime,
  daysOverdue,
} from "@/components/tasks/task-ui";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, EmptyState, ErrorState, Spinner } from "@/components/ui/card";
import {
  Badge,
  ConfirmDialog,
  Dialog,
  Field,
  Input,
  Label,
  Progress,
  Select,
  Textarea,
} from "@/components/ui/form";
import { api, ApiError, qs } from "@/lib/api";
import { useAuth, useDirectory } from "@/lib/auth";
import {
  formatDateTime,
  formatDuration,
  fromLocalInput,
  toLocalInput,
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
  const today = new Date().toISOString().slice(0, 10);
  const late = daysOverdue(t.due_date, today);

  const changeStatus = async (status: TaskStatus, extra: Record<string, unknown> = {}) => {
    await api<Task>(`/tasks/${t.id}/status`, { method: "POST", json: { status, ...extra } });
    toast.success(`Moved to ${STATUS_LABELS[status]}`);
    await invalidate();
  };

  const remove = async () => {
    await api(`/tasks/${t.id}`, { method: "DELETE" });
    toast.success("Task deleted");
    router.push("/my-tasks");
  };

  const restore = async () => {
    await api(`/tasks/${t.id}/restore`, { method: "POST", json: {} });
    toast.success("Task restored");
    await invalidate();
  };

  return (
    <>
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

      <div className="mb-5 flex flex-wrap items-center gap-2">
        <StatusBadge status={t.status} />
        <PriorityBadge priority={t.priority} />
        {late ? <OverdueBadge days={late} /> : null}
        {t.requires_review ? <Badge variant="warning">Requires review</Badge> : null}
        {t.deleted_at ? <Badge variant="danger">Deleted</Badge> : null}
        <TrackedTime seconds={t.tracked_seconds} />
      </div>

      {t.blocked_reason ? (
        <Card className="mb-5 border-destructive/40">
          <CardHeader>
            <CardTitle className="text-destructive">Blocked</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-sm">{t.blocked_reason}</p>
          </CardContent>
        </Card>
      ) : null}

      <div className="grid gap-5 lg:grid-cols-[1fr_320px]">
        <div className="flex flex-col gap-5">
          <Card>
            <CardHeader>
              <div className="flex items-center justify-between">
                <CardTitle>{tab === "log" ? "Work log" : "History"}</CardTitle>
                <div className="flex gap-1 rounded-md bg-muted p-0.5">
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
                  canSeeDeleted={canSeeDeleted}
                  onChanged={invalidate}
                />
              ) : (
                <HistoryList events={history.data?.items ?? []} isLoading={history.isLoading} />
              )}
            </CardContent>
          </Card>
        </div>

        <aside className="flex flex-col gap-5">
          <Card>
            <CardHeader>
              <CardTitle>Details</CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-3 text-sm">
              {t.description ? (
                <p className="whitespace-pre-wrap text-muted-foreground">{t.description}</p>
              ) : null}
              <Detail label="Progress">
                <div className="flex items-center gap-2">
                  <Progress value={t.progress_percent} />
                  <span className="tabular text-xs text-muted-foreground">{t.progress_percent}%</span>
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
                    className="inline-flex items-center gap-1 text-primary hover:underline"
                  >
                    <Link2 className="h-3.5 w-3.5" aria-hidden />
                    Open link
                  </a>
                </Detail>
              ) : null}
              <Detail label="Links">
                <div className="flex flex-col gap-1">
                  {(taskLinks.data ?? []).length === 0 ? (
                    <span className="text-muted-foreground">None attached to this task</span>
                  ) : (
                    (taskLinks.data ?? []).map((link) => (
                      <a
                        key={link.id}
                        href={link.url}
                        target="_blank"
                        rel="noopener noreferrer nofollow"
                        className="inline-flex items-center gap-1 text-primary hover:underline"
                      >
                        <Link2 className="h-3.5 w-3.5" aria-hidden />
                        {link.title}
                      </a>
                    ))
                  )}
                  {capabilities?.can_add_links ? (
                    <button
                      type="button"
                      className="mt-1 inline-flex w-fit items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
                      onClick={() => setDialog("link")}
                    >
                      <Plus className="h-3 w-3" aria-hidden />
                      Attach a link
                    </button>
                  ) : null}
                </div>
              </Detail>
              <Detail label="Created by">{t.created_by?.full_name ?? "—"}</Detail>
              <Detail label="Created">{formatDateTime(t.created_at)}</Detail>
              {t.completed_at ? (
                <Detail label="Completed">{formatDateTime(t.completed_at)}</Detail>
              ) : null}
            </CardContent>
          </Card>
        </aside>
      </div>

      <AddTimeDialog
        open={dialog === "add_time"}
        onClose={() => setDialog(null)}
        taskId={t.id}
        onDone={invalidate}
      />
      <AttachLinkDialog
        open={dialog === "link"}
        onClose={() => setDialog(null)}
        taskId={t.id}
        onDone={invalidate}
      />
      <NoteDialog
        open={dialog === "note"}
        onClose={() => setDialog(null)}
        taskId={t.id}
        onDone={invalidate}
      />
      <StatusDialog
        open={dialog === "status"}
        onClose={() => setDialog(null)}
        task={t}
        onSubmit={changeStatus}
      />
      <EditTaskDialog
        open={dialog === "edit"}
        onClose={() => setDialog(null)}
        task={t}
        onDone={invalidate}
      />
      <AssignDialog
        open={dialog === "assign"}
        onClose={() => setDialog(null)}
        task={t}
        onDone={invalidate}
      />
    </>
  );
}

function Detail({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <Label>{label}</Label>
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
      className={`inline-flex items-center gap-1 rounded px-2.5 py-1 text-xs font-medium transition-colors ${
        active ? "bg-card text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"
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
  canSeeDeleted,
  onChanged,
}: {
  logs: TaskLog[];
  isLoading: boolean;
  canSeeDeleted: boolean;
  onChanged: () => void;
}) {
  const [editing, setEditing] = useState<TaskLog | null>(null);
  const [deleting, setDeleting] = useState<TaskLog | null>(null);

  if (isLoading) return <Spinner label="Loading log" />;
  if (logs.length === 0) {
    return (
      <EmptyState
        title="No time recorded yet"
        description="Press Start to track time, or add an entry manually for something you forgot."
      />
    );
  }

  return (
    <>
      <ul className="flex flex-col divide-y divide-border">
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
      <EditLogDialog log={editing} onClose={() => setEditing(null)} onDone={onChanged} />
      <ConfirmDialog
        open={deleting !== null}
        onClose={() => setDeleting(null)}
        destructive
        confirmLabel="Delete entry"
        title="Delete this time entry?"
        description="The entry is soft-deleted and removed from totals. Management can still see that it was deleted — this is recorded as an audit event."
        onConfirm={async () => {
          if (!deleting) return;
          try {
            await api(`/logs/${deleting.id}`, { method: "DELETE" });
            toast.success("Entry deleted");
            setDeleting(null);
            onChanged();
          } catch (error) {
            toast.error(error instanceof ApiError ? error.message : "Could not delete");
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
      className={`flex flex-wrap items-start gap-3 py-3 ${log.deleted_at ? "opacity-60" : ""}`}
    >
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="tabular font-medium">
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
        {log.note ? <p className="mt-1.5 text-sm">{log.note}</p> : null}
        {log.progress_percent !== null ? (
          <p className="mt-1 text-xs text-muted-foreground">Progress set to {log.progress_percent}%</p>
        ) : null}
        {log.evidence_url ? (
          <a
            href={log.evidence_url}
            target="_blank"
            rel="noopener noreferrer nofollow"
            className="mt-1 inline-flex items-center gap-1 text-xs text-primary hover:underline"
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

function HistoryList({ events, isLoading }: { events: AuditEvent[]; isLoading: boolean }) {
  if (isLoading) return <Spinner label="Loading history" />;
  if (events.length === 0) {
    return <EmptyState title="No history yet" description="Every change to this task will appear here." />;
  }
  return (
    <ul className="flex flex-col gap-3">
      {events.map((event) => (
        <li key={event.id} className="border-b border-border pb-3 last:border-b-0">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="outline">{EVENT_LABELS[event.event_type] ?? event.event_type}</Badge>
            <span className="text-xs text-muted-foreground">
              {event.actor_name} · {formatDateTime(event.created_at)}
            </span>
          </div>
          <p className="mt-1.5 text-sm">{event.summary}</p>
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
    <table className="mt-2 w-full text-xs">
      <tbody>
        {keys.map((key) => (
          <tr key={key} className="align-top">
            <td className="w-32 py-0.5 pr-2 text-muted-foreground">{key}</td>
            <td className="py-0.5 pr-2 text-muted-foreground line-through">
              {renderValue(before?.[key])}
            </td>
            <td className="py-0.5">{renderValue(after?.[key])}</td>
          </tr>
        ))}
      </tbody>
    </table>
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
  const [startedAt, setStartedAt] = useState(toLocalInput(new Date().toISOString()));
  const [endedAt, setEndedAt] = useState(toLocalInput(new Date().toISOString()));
  const [note, setNote] = useState("");
  const [progress, setProgress] = useState("");
  const [evidence, setEvidence] = useState("");

  const mutation = useMutation({
    mutationFn: () =>
      api(`/tasks/${taskId}/logs`, {
        method: "POST",
        json: {
          entry_type: "work_session",
          started_at: fromLocalInput(startedAt),
          ended_at: fromLocalInput(endedAt),
          note: note || null,
          progress_percent: progress === "" ? null : Number(progress),
          evidence_url: evidence || null,
        },
      }),
    onSuccess: async () => {
      toast.success("Time added");
      setNote("");
      setProgress("");
      setEvidence("");
      onClose();
      await onDone();
    },
    onError: (error) =>
      toast.error(error instanceof ApiError ? error.message : "Could not add the entry"),
  });

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Add time manually"
      description="For work you forgot to time. The entry is checked for overlaps."
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={() => mutation.mutate()} loading={mutation.isPending}>
            Add entry
          </Button>
        </>
      }
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Started">
          <Input type="datetime-local" value={startedAt} onChange={(e) => setStartedAt(e.target.value)} />
        </Field>
        <Field label="Ended">
          <Input type="datetime-local" value={endedAt} onChange={(e) => setEndedAt(e.target.value)} />
        </Field>
        <Field label="Progress %" hint="Optional">
          <Input
            type="number"
            min={0}
            max={100}
            value={progress}
            onChange={(e) => setProgress(e.target.value)}
          />
        </Field>
        <Field label="Evidence URL" hint="Optional, http(s) only">
          <Input value={evidence} onChange={(e) => setEvidence(e.target.value)} />
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

  const folders = useQuery({
    queryKey: ["folders"],
    queryFn: () => api<Folder[]>(`/workspace/folders`),
    enabled: open,
  });

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
      setTitle("");
      setUrl("");
      onClose();
      await onDone();
    },
    onError: (error) =>
      toast.error(error instanceof ApiError ? error.message : "Could not attach the link"),
  });

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Attach a link to this task"
      description="Reference material, a draft, a live campaign — anything this task should point at."
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            onClick={() => mutation.mutate()}
            loading={mutation.isPending}
            disabled={!title.trim() || !url.trim()}
          >
            Attach
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <Field label="Title">
          <Input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} />
        </Field>
        <Field label="URL" hint="Must start with http:// or https://">
          <Input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://…" />
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
  const [startedAt, setStartedAt] = useState("");
  const [endedAt, setEndedAt] = useState("");
  const [note, setNote] = useState("");
  const [reason, setReason] = useState("");

  const mutation = useMutation({
    mutationFn: () => {
      if (!log) return Promise.resolve();
      const body: Record<string, unknown> = {
        started_at: fromLocalInput(startedAt),
        note,
        edit_reason: reason || null,
        if_ended_at_unchanged: true,
      };
      if (log.ended_at && endedAt) body.ended_at = fromLocalInput(endedAt);
      return api(`/logs/${log.id}`, { method: "PATCH", json: body });
    },
    onSuccess: async () => {
      toast.success("Entry updated — the change is recorded in the history");
      onClose();
      await onDone();
    },
    onError: (error) =>
      toast.error(error instanceof ApiError ? error.message : "Could not update the entry"),
  });

  const isRunning = log?.ended_at === null;

  return (
    <Dialog
      open={log !== null}
      onClose={onClose}
      title="Edit time entry"
      description="Your change is audited with the values before and after."
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            onClick={() => {
              if (log) {
                setStartedAt(toLocalInput(log.started_at));
                setEndedAt(log.ended_at ? toLocalInput(log.ended_at) : "");
                setNote(log.note ?? "");
                setReason("");
              }
            }}
            variant="secondary"
          >
            Load values
          </Button>
          <Button
            onClick={() => mutation.mutate()}
            loading={mutation.isPending}
            disabled={!startedAt || (!isRunning && !endedAt)}
          >
            Save
          </Button>
        </>
      }
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Started">
          <Input type="datetime-local" value={startedAt} onChange={(e) => setStartedAt(e.target.value)} />
        </Field>
        <Field
          label="Ended"
          hint={isRunning ? "A running timer is closed with Pause, not here." : undefined}
        >
          <Input
            type="datetime-local"
            value={endedAt}
            disabled={isRunning}
            onChange={(e) => setEndedAt(e.target.value)}
          />
        </Field>
        <div className="sm:col-span-2">
          <Field label="Note">
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

  const needsReason = status === "blocked";
  const needsNote =
    (task.status === "completed" && status === "in_progress") ||
    (task.status === "in_review" && status === "in_progress");

  const submit = async () => {
    setBusy(true);
    try {
      await onSubmit(status, {
        reason: needsReason ? reason : null,
        note: note || null,
      });
      onClose();
      setReason("");
      setNote("");
    } catch (error) {
      toast.error(error instanceof ApiError ? error.message : "Could not change the status");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Change status"
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={submit} loading={busy} disabled={status === task.status}>
            Apply
          </Button>
        </>
      }
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
          <Field label="Why is it blocked?" hint="At least 3 characters. Also saved as a log note.">
            <Textarea value={reason} onChange={(e) => setReason(e.target.value)} maxLength={2000} />
          </Field>
        ) : null}
        {needsNote || note.length > 0 || status !== task.status ? (
          <Field label="Note" hint={needsNote ? "Required for this transition." : "Optional"}>
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
      if (Number(form.progress_percent) !== task.progress_percent)
        body.progress_percent = Number(form.progress_percent);
      if (form.evidence_url !== (task.evidence_url ?? "")) body.evidence_url = form.evidence_url || null;
      return api(`/tasks/${task.id}`, { method: "PATCH", json: body });
    },
    onSuccess: async () => {
      toast.success("Task updated");
      onClose();
      await onDone();
    },
    onError: (error) =>
      toast.error(error instanceof ApiError ? error.message : "Could not update the task"),
  });

  const set = (key: keyof typeof form) => (event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) =>
    setForm((prev) => ({ ...prev, [key]: event.target.value }));

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Edit task"
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={() => mutation.mutate()} loading={mutation.isPending}>
            Save changes
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <Field label="Title">
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
          <Field label="Progress %">
            <Input
              type="number"
              min={0}
              max={100}
              value={form.progress_percent}
              onChange={set("progress_percent")}
            />
          </Field>
          <Field label="Evidence URL">
            <Input value={form.evidence_url} onChange={set("evidence_url")} />
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
    mutationFn: () => api(`/tasks/${task.id}/assign`, { method: "POST", json: { assignee_id: Number(assigneeId) } }),
    onSuccess: async () => {
      toast.success("Task reassigned");
      onClose();
      await onDone();
    },
    onError: (error) =>
      toast.error(error instanceof ApiError ? error.message : "Could not reassign"),
  });

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Reassign task"
      description="Any running timer on this task is closed and the previous assignee keeps their log entries."
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={() => mutation.mutate()} loading={mutation.isPending} disabled={!assigneeId}>
            Reassign
          </Button>
        </>
      }
    >
      <Field label="Assignee">
        <Select value={assigneeId} onChange={(e) => setAssigneeId(e.target.value)}>
          <option value="">Choose a person…</option>
          {(directory.data ?? [])
            .filter((entry) => entry.is_active)
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