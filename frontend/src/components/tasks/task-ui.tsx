"use client";

import { Play, Square } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Badge, Progress } from "@/components/ui/form";
import { api, ApiError } from "@/lib/api";
import { formatDuration } from "@/lib/format";
import { PRIORITY_LABELS, STATUS_LABELS, type Priority, type Task, type TaskStatus } from "@/lib/types";
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
      toast.error(error instanceof ApiError ? error.message : "Could not start the timer");
    } finally {
      setBusy(false);
    }
  };

  const pause = async () => {
    setBusy(true);
    try {
      await api("/timer/pause", { method: "POST", json: {} });
      toast.success("Timer paused");
      onChanged();
    } catch (error) {
      toast.error(error instanceof ApiError ? error.message : "Could not pause the timer");
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
  if (actions.includes("switch_timer")) {
    return (
      <Button size={size} variant="outline" onClick={start} loading={busy}>
        <Play className="h-4 w-4" aria-hidden />
        Switch here
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

export function TaskRow({ task, today, onChanged }: { task: Task; today: string; onChanged: () => void }) {
  const late = daysOverdue(task.due_date, today);
  return (
    <li className="flex items-start gap-3 border-b border-border px-4 py-3 last:border-b-0">
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <Link
            href={`/tasks/${task.id}`}
            className="truncate font-medium hover:underline"
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
          {task.assignee ? <span>{task.assignee.full_name}</span> : <span>Unassigned</span>}
          {task.due_date ? <span>Due {task.due_date}</span> : null}
          <TrackedTime seconds={task.tracked_seconds} />
          <span>{task.log_count} entries</span>
        </div>
        {task.progress_percent > 0 ? (
          <div className="mt-2 max-w-xs">
            <Progress value={task.progress_percent} />
          </div>
        ) : null}
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <TimerActions task={task} onChanged={onChanged} />
      </div>
    </li>
  );
}

export function daysOverdue(dueDate: string | null, today: string): number | null {
  if (!dueDate) return null;
  const due = new Date(`${dueDate}T00:00:00Z`).getTime();
  const now = new Date(`${today}T00:00:00Z`).getTime();
  const days = Math.round((now - due) / 86_400_000);
  return days > 0 ? days : null;
}

export function TaskCard({ task, today }: { task: Task; today: string }) {
  const late = daysOverdue(task.due_date, today);
  return (
    <Link
      href={`/tasks/${task.id}`}
      className={cn(
        "block rounded-lg border border-border bg-card p-4 transition-colors hover:border-primary/50",
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <p className="font-medium leading-snug">{task.title}</p>
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