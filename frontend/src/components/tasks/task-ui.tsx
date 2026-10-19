"use client";

import { Bell, Play, Square } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { toast } from "sonner";

import { Avatar, displayName } from "@/components/avatar";
import { Button } from "@/components/ui/button";
import { Badge, Input, Progress } from "@/components/ui/form";
import { api, errorMessage } from "@/lib/api";
import { formatDuration, overdueDays } from "@/lib/format";
import { PRIORITY_LABELS, STATUS_LABELS, type Priority, type StatusMove, type Task, type TaskStatus } from "@/lib/types";
import { cn } from "@/lib/utils";

export function StatusBadge({ status }: { status: TaskStatus }) {
  const variant =
    status === "completed"
      ? "success"
      : status === "blocked"
        ? "danger"
        : status === "in_progress"
          ? "default"
          : status === "in_review"
            ? "warning"
            : "muted";
  return <Badge variant={variant}>{STATUS_LABELS[status]}</Badge>;
}

export function PriorityBadge({ priority }: { priority: Priority }) {
  const variant = priority === "urgent" ? "danger" : priority === "high" ? "warning" : "muted";
  return <Badge variant={variant}>{PRIORITY_LABELS[priority]}</Badge>;
}

export function OverdueBadge({ days }: { days: number }) {
  return <Badge variant="danger">Overdue {days}d</Badge>;
}

export function TrackedTime({ seconds }: { seconds: number }) {
  return <span className="tabular text-xs text-muted-foreground">{formatDuration(seconds)}</span>;
}

/**
 * Timer controls rendered purely from task.allowed_actions, which the server computes
 * (FR-TASK-004). Hiding a button is never the control; the backend still enforces it.
 */
export function TimerActions({
  task,
  onChanged,
  size = "sm",
}: {
  task: Task;
  onChanged: () => void;
  size?: "sm" | "default";
}) {
  const [busy, setBusy] = useState(false);
  const actions = task.allowed_actions;

  const start = async () => {
    setBusy(true);
    try {
      const result = await api<{ paused_previous: { task_title: string } | null }>(
        `/tasks/${task.id}/timer/start`,
        { method: "POST", json: {} },
      );
      if (result.paused_previous) {
        toast.info(`Paused the timer on “${result.paused_previous.task_title}”`);
      }
      onChanged();
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setBusy(false);
    }
  };

  const pause = async () => {
    setBusy(true);
    try {
      // Timers are concurrent, so pause this task's timer by id rather than
      // whichever one happens to be "current". `running` is now guaranteed to
      // be the caller's own timer -- it used to be any user's, so this could
      // pause a colleague's session.
      await api("/timer/pause", {
        method: "POST",
        json: task.running ? { log_id: task.running.log_id } : {},
      });
      toast.success("Timer paused");
      onChanged();
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setBusy(false);
    }
  };

  if (actions.includes("pause_timer")) {
    return (
      <Button size={size} variant="outline" onClick={pause} loading={busy}>
        <Square className="h-4 w-4" aria-hidden />
        Pause
      </Button>
    );
  }
  if (actions.includes("start_timer")) {
    const resumed = task.tracked_seconds > 0;
    return (
      <Button size={size} onClick={start} loading={busy}>
        <Play className="h-4 w-4" aria-hidden />
        {resumed ? "Resume" : "Start"}
      </Button>
    );
  }
  return null;
}

/**
 * Who is working on this task right now.
 *
 * `task.running` is deliberately only ever the caller's own timer, so anything
 * on this task belongs to somebody else and must not be shown as pausable.
 */
export function OtherRunners({ task }: { task: Task }) {
  if (!task.other_runners?.length) return null;
  return (
    <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
      <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-success" aria-hidden />
      {task.other_runners
        .map((r) => r.user?.full_name ?? "Someone")
        .join(", ")}{" "}
      {task.other_runners.length === 1 ? "is" : "are"} on this now
    </span>
  );
}

/**
 * Inline status control, so nobody has to open a task to move it.
 *
 * The buttons are rendered from `task.allowed_statuses`, which the server
 * derives from the same transition table `POST /tasks/{id}/status` enforces.
 * Copying those rules into the client is what produces a "Complete" button that
 * always answers 409 INVALID_TRANSITION, or a reviewer-only approval offered to
 * the assignee -- so nothing here decides what is legal.
 *
 * A move flagged `requires_reason` or `requires_note` asks for it inline rather
 * than firing a request that is guaranteed to come back with a 409.
 */
export function StatusBar({
  task,
  onChanged,
}: {
  task: Task;
  onChanged: () => void;
}) {
  const [pending, setPending] = useState<string | null>(null);
  const [asking, setAsking] = useState<StatusMove | null>(null);
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);

  const moves = task.allowed_statuses ?? [];
  if (task.deleted_at || moves.length === 0) return null;

  const move = async (target: StatusMove, extra?: string) => {
    setPending(target.status);
    setError(null);
    try {
      await api(`/tasks/${task.id}/status`, {
        method: "POST",
        json: {
          status: target.status,
          reason: target.requires_reason ? extra ?? null : null,
          note: target.requires_note ? extra ?? null : null,
        },
      });
      setAsking(null);
      setText("");
      toast.success(`Moved to ${STATUS_LABELS[target.status]}`);
      onChanged();
    } catch (err) {
      setError(errorMessage(err));
      toast.error(errorMessage(err));
    } finally {
      setPending(null);
    }
  };

  return (
    <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
      <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
        Move to
      </span>
      {moves.map((option) => (
        <button
          key={option.status}
          type="button"
          disabled={pending !== null}
          onClick={() =>
            option.requires_reason || option.requires_note
              ? setAsking(option)
              : void move(option)
          }
          className={cn(
            "rounded-full border px-2.5 py-0.5 text-xs font-medium transition-colors",
            "border-[#145338]/25 bg-[#eaf4ef] text-[#145338] hover:bg-[#145338] hover:text-white",
            "disabled:cursor-not-allowed disabled:opacity-50",
          )}
          title={
            option.requires_reason
              ? `Needs a reason of at least 3 characters`
              : option.requires_note
                ? "Needs a note"
                : undefined
          }
        >
          {pending === option.status ? "…" : STATUS_LABELS[option.status]}
        </button>
      ))}

      {asking ? (
        <span className="flex flex-wrap items-center gap-2">
          <Input
            className="h-8 max-w-[16rem] text-xs"
            autoFocus
            placeholder={
              asking.requires_reason ? "Reason (at least 3 characters)" : "Note"
            }
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") setAsking(null);
              if (e.key === "Enter" && text.trim()) void move(asking, text.trim());
            }}
          />
          <Button
            size="sm"
            variant="outline"
            disabled={pending !== null || text.trim().length < 3}
            onClick={() => void move(asking, text.trim())}
          >
            {pending ? "…" : "Confirm"}
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setAsking(null)}>
            Cancel
          </Button>
        </span>
      ) : null}

      {error ? <span className="text-xs text-destructive">{error}</span> : null}
    </div>
  );
}

/**
 * Who owns a task, as a picture and a link to their profile.
 *
 * This used to be the assignee's bare name in the meta line. On a board of forty
 * rows that is forty identical grey words, and there was no way to get from a
 * task to the person carrying it -- the profile only existed on Tracked Time.
 */
export function AssigneeTag({ assignee }: { assignee: Task["assignee"] }) {
  if (!assignee) {
    return <span className="text-muted-foreground">Unassigned</span>;
  }
  return (
    <Link
      href={`/users/${assignee.id}`}
      className="inline-flex min-w-0 items-center gap-1.5 rounded-full py-0.5 pr-2 text-xs text-foreground/80 transition-colors hover:bg-muted hover:text-[#145338]"
      title={`Open ${displayName(assignee)}'s profile`}
    >
      <Avatar person={assignee} size="xs" />
      <span className="max-w-[10rem] truncate font-medium">{displayName(assignee)}</span>
    </Link>
  );
}

export function TaskRow({
  task,
  today,
  onChanged,
  canRemind,
}: {
  task: Task;
  today: string;
  onChanged: () => void;
  canRemind?: boolean;
}) {
  const late = overdueDays(task.due_date, today);
  const [reminding, setReminding] = useState(false);
  const [remindOpen, setRemindOpen] = useState(false);
  const [message, setMessage] = useState("");

  const remind = async (text: string) => {
    setReminding(true);
    try {
      await api(`/tasks/${task.id}/remind`, {
        method: "POST",
        json: { message: text.trim() || null },
      });
      toast.success(
        task.assignee
          ? `Reminder sent to ${task.assignee.full_name}`
          : "Reminder sent",
      );
      setRemindOpen(false);
      setMessage("");
      onChanged();
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setReminding(false);
    }
  };

  return (
    <li className="flex items-start gap-3 border-b border-border/70 px-5 py-3.5 transition-colors hover:bg-muted/40 last:border-b-0">
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <Link
            href={`/tasks/${task.id}`}
            className="truncate font-semibold text-foreground hover:text-[#145338] hover:underline"
          >
            {task.title}
          </Link>
          {late ? <OverdueBadge days={late} /> : null}
          {task.requires_review ? <Badge variant="outline">Review required</Badge> : null}
          {task.deleted_at ? <Badge variant="danger">Deleted</Badge> : null}
        </div>
        <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
          <StatusBadge status={task.status} />
          <PriorityBadge priority={task.priority} />
          <AssigneeTag assignee={task.assignee} />
          {task.due_date ? <span>Due {task.due_date}</span> : null}
          <TrackedTime seconds={task.tracked_seconds} />
          <span>{task.log_count} entries</span>
        </div>
        {task.progress_percent > 0 ? (
          <div className="mt-2 max-w-xs">
            <Progress value={task.progress_percent} />
          </div>
        ) : null}
        <StatusBar task={task} onChanged={onChanged} />
        {remindOpen ? (
          <div className="mt-2.5 flex flex-wrap items-center gap-2">
            <Input
              className="h-8 max-w-xs"
              placeholder="Reminder (optional)"
              value={message}
              onChange={(e) => setMessage(e.target.value)}
            />
            <Button
              size="sm"
              loading={reminding}
              onClick={() => void remind(message)}
            >
              Send
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setRemindOpen(false)}>
              Cancel
            </Button>
          </div>
        ) : null}
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {canRemind && !task.deleted_at ? (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => setRemindOpen((v) => !v)}
            title={task.assignee ? `Remind ${task.assignee.full_name}` : "No assignee yet"}
          >
            <Bell className="h-4 w-4" aria-hidden />
            <span className="sr-only">Remind</span>
          </Button>
        ) : null}
        <TimerActions task={task} onChanged={onChanged} />
      </div>
    </li>
  );
}

export function TaskCard({ task, today }: { task: Task; today: string }) {
  const late = overdueDays(task.due_date, today);
  return (
    <Link
      href={`/tasks/${task.id}`}
      className={cn(
        "block rounded-2xl border border-border/80 bg-card p-4 shadow-[0_2px_10px_rgba(0,0,0,0.02)] transition-all hover:border-[#145338]/40",
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <p className="font-semibold leading-snug">{task.title}</p>
        {late ? <OverdueBadge days={late} /> : null}
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <StatusBadge status={task.status} />
        <PriorityBadge priority={task.priority} />
        <TrackedTime seconds={task.tracked_seconds} />
      </div>
    </Link>
  );
}