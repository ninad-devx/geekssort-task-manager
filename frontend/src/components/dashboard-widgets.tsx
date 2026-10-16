"use client";

import {
  AlertTriangle,
  ArrowUpRight,
  CheckCircle2,
  FolderKanban,
  Pause,
  Play,
  Plus,
  Square,
  Timer,
} from "lucide-react";
import Link from "next/link";
import { useId, useState } from "react";
import { toast } from "sonner";

import { roleLabel } from "@/components/app-shell";
import { Avatar, displayName } from "@/components/avatar";
import { StatusBadge } from "@/components/tasks/task-ui";
import { useElapsed, useRunningTimer } from "@/components/timer-bar";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/form";
import { api, ApiError } from "@/lib/api";
import { formatClock, formatDuration, formatHours } from "@/lib/format";
import {
  STATUS_LABELS,
  type DashboardPayload,
  type Task,
  type TaskStatus,
  type WorklistRow,
} from "@/lib/types";
import { cn } from "@/lib/utils";

/**
 * 1. Reusable Statistics Card inspired by the Donezo reference.
 * Supports primary hero green gradient (`featured`) and clean white surface cards.
 */
export function StatCard({
  label,
  value,
  hint,
  badgeText,
  href,
  featured = false,
  tone = "default",
}: {
  label: string;
  value: number | string;
  hint: string;
  badgeText?: string | number;
  href: string;
  featured?: boolean;
  tone?: "default" | "danger" | "success";
}) {
  return (
    <Link href={href} className="group block h-full focus-visible:outline-none">
      <div
        className={cn(
          "relative flex h-full flex-col justify-between rounded-2xl p-5 transition-all duration-200 group-hover:-translate-y-0.5",
          featured
            ? "hero-green-card shadow-[0_8px_24px_rgba(20,83,56,0.22)]"
            : "border border-border/80 bg-card text-card-foreground shadow-[0_2px_10px_rgba(0,0,0,0.02)] hover:border-[#145338]/40",
        )}
      >
        <div className="flex items-start justify-between gap-2">
          <span
            className={cn(
              "text-sm font-medium",
              featured ? "text-white/90" : "text-foreground",
            )}
          >
            {label}
          </span>
          <span
            className={cn(
              "flex h-8 w-8 shrink-0 items-center justify-center rounded-full border transition-transform duration-200 group-hover:scale-105",
              featured
                ? "border-white/20 bg-white text-[#145338]"
                : "border-foreground/20 bg-card text-foreground group-hover:border-[#145338] group-hover:text-[#145338]",
            )}
            aria-hidden
          >
            <ArrowUpRight className="h-4 w-4" />
          </span>
        </div>

        <div className="my-3">
          <p
            className={cn(
              "tabular text-4xl font-bold tracking-tight",
              featured
                ? "text-white"
                : tone === "danger"
                  ? "text-destructive"
                  : "text-foreground",
            )}
          >
            {value}
          </p>
        </div>

        <div className="flex items-center gap-1.5 text-xs">
          {badgeText !== undefined ? (
            <span
              className={cn(
                "inline-flex items-center rounded-md border px-1.5 py-0.5 text-[10px] font-semibold tabular",
                featured
                  ? "border-white/30 bg-white/15 text-white"
                  : tone === "danger"
                    ? "border-destructive/30 bg-destructive/10 text-destructive"
                    : "border-[#1f7a52]/30 bg-[#eaf4ef] text-[#145338]",
              )}
            >
              {badgeText}
            </span>
          ) : null}
          <span
            className={cn(
              "truncate",
              featured
                ? "text-[#a9dfc2]"
                : tone === "danger"
                  ? "text-destructive/90"
                  : "text-[#1f7a52]",
            )}
          >
            {hint}
          </span>
        </div>
      </div>
    </Link>
  );
}

/**
 * 2. Main Analytics Visualization (Rounded vertical capsule bars + striped treatment).
 * Uses real `daily` time-tracking data when present (personal dashboard) or real
 * `counts.by_status` task status distribution.
 */
const STATUS_ORDER: TaskStatus[] = ["todo", "in_progress", "in_review", "blocked", "completed"];

const STATUS_BAR_STYLES: Record<
  TaskStatus,
  { style: "striped" | "solid"; bg?: string; label: string; short: string }
> = {
  todo: { style: "striped", label: "To Do", short: "TD" },
  in_progress: { style: "solid", bg: "#1f7a52", label: "In Progress", short: "IP" },
  in_review: { style: "solid", bg: "#4db380", label: "In Review", short: "IR" },
  blocked: { style: "striped", label: "Blocked", short: "BL" },
  completed: { style: "solid", bg: "#145338", label: "Completed", short: "CM" },
};

export function AnalyticsChartCard({
  payload,
  taskListBase,
  completedWindow = "",
}: {
  payload: DashboardPayload;
  taskListBase: string;
  completedWindow?: string;
}) {
  const hasDaily = Boolean(payload.daily && payload.daily.length > 0);
  const [chartView, setChartView] = useState<"status" | "daily">(hasDaily ? "daily" : "status");
  const activeView = hasDaily ? chartView : "status";

  const counts = payload.counts;
  // Use `counts.completed_in_range` for the Completed bar so the chart updates
  // dynamically when switching between Today, Last 7 days, Last 30 days, and Last 90 days.
  const periodByStatus: Record<TaskStatus, number> = {
    ...counts.by_status,
    completed: counts.completed_in_range,
  };
  const periodTotalTasks =
    (periodByStatus.todo ?? 0) +
    (periodByStatus.in_progress ?? 0) +
    (periodByStatus.in_review ?? 0) +
    (periodByStatus.blocked ?? 0) +
    (periodByStatus.completed ?? 0);
  const totalForPct = Math.max(1, periodTotalTasks);

  return (
    <Card className="flex flex-col justify-between">
      <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2 pb-2">
        <div>
          <CardTitle>
            {activeView === "daily" ? "Tracked Time Analytics" : "Task Status Analytics"}
          </CardTitle>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {activeView === "daily"
              ? `Daily logged hours across ${payload.period_label ?? "selected range"}`
              : `${counts.open} open now · ${counts.completed_in_range} completed ${payload.period_label ?? "in range"}`}
          </p>
        </div>
        {hasDaily ? (
          <div className="flex rounded-full bg-muted p-0.5 text-xs">
            <button
              type="button"
              onClick={() => setChartView("daily")}
              className={cn(
                "rounded-full px-2.5 py-1 font-medium transition-colors",
                activeView === "daily"
                  ? "bg-card text-foreground shadow-2xs"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              Daily Time
            </button>
            <button
              type="button"
              onClick={() => setChartView("status")}
              className={cn(
                "rounded-full px-2.5 py-1 font-medium transition-colors",
                activeView === "status"
                  ? "bg-card text-foreground shadow-2xs"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              By Status
            </button>
          </div>
        ) : null}
      </CardHeader>

      <CardContent className="pt-2">
        {activeView === "daily" && payload.daily ? (
          <DailyCapsuleBars daily={payload.daily} />
        ) : (
          <StatusCapsuleBars
            byStatus={periodByStatus}
            total={totalForPct}
            taskListBase={taskListBase}
            completedWindow={completedWindow}
            periodLabel={payload.period_label}
          />
        )}
      </CardContent>
    </Card>
  );
}

function StatusCapsuleBars({
  byStatus,
  total,
  taskListBase,
  completedWindow = "",
  periodLabel,
}: {
  byStatus: Record<TaskStatus, number>;
  total: number;
  taskListBase: string;
  completedWindow?: string;
  periodLabel?: string;
}) {
  const maxVal = Math.max(1, ...STATUS_ORDER.map((s) => byStatus[s] ?? 0));

  return (
    <div>
      <div
        className="flex h-44 items-end justify-between gap-3 pt-6 sm:gap-5"
        role="img"
        aria-label="Distribution of tasks by status"
      >
        {STATUS_ORDER.map((status) => {
          const count = byStatus[status] ?? 0;
          const pct = Math.round((count / total) * 100);
          // Minimum capsule height so 0-count statuses still show a subtle striped pill like Donezo
          const heightPct = count > 0 ? Math.max(24, Math.round((count / maxVal) * 100)) : 22;
          const meta = STATUS_BAR_STYLES[status];
          const isStriped = count === 0 || meta.style === "striped";
          const href =
            status === "completed"
              ? `${taskListBase}?status=completed${completedWindow}`
              : `${taskListBase}?status=${status}`;

          return (
            <Link
              key={status}
              href={href}
              className="group relative flex h-full flex-1 flex-col items-center justify-end gap-2 focus-visible:outline-none"
              title={
                status === "completed" && periodLabel
                  ? `${meta.label} (${periodLabel}): ${count} (${pct}%)`
                  : `${meta.label}: ${count} (${pct}%)`
              }
            >
              {/* Floating pill tooltip above bar */}
              <span
                className={cn(
                  "rounded-md border px-1.5 py-0.5 text-[10px] font-semibold tabular transition-all",
                  count > 0
                    ? "border-[#145338]/20 bg-white text-[#145338] shadow-2xs"
                    : "border-transparent bg-transparent text-muted-foreground opacity-0 group-hover:opacity-100",
                )}
              >
                {count} ({pct}%)
              </span>

              <div className="relative flex w-full max-w-[52px] flex-1 items-end">
                <div
                  className={cn(
                    "w-full rounded-full transition-all duration-300 group-hover:scale-[1.03]",
                    isStriped ? "striped-bar" : "shadow-xs",
                  )}
                  style={{
                    height: `${heightPct}%`,
                    backgroundColor: !isStriped ? meta.bg : undefined,
                  }}
                />
              </div>

              <span className="text-[11px] font-medium text-muted-foreground group-hover:text-foreground">
                <span className="hidden sm:inline">{meta.label}</span>
                <span className="sm:hidden">{meta.short}</span>
              </span>
            </Link>
          );
        })}
      </div>

      {/* Accessible status summary row */}
      <div className="mt-4 flex flex-wrap items-center justify-between gap-2 border-t border-border/60 pt-3 text-xs text-muted-foreground">
        {STATUS_ORDER.map((status) => {
          const href =
            status === "completed"
              ? `${taskListBase}?status=completed${completedWindow}`
              : `${taskListBase}?status=${status}`;
          return (
            <Link
              key={status}
              href={href}
              className="inline-flex items-center gap-1.5 hover:text-foreground"
            >
              <span
                className={cn(
                  "h-2.5 w-2.5 rounded-full",
                  STATUS_BAR_STYLES[status].style === "striped" ? "striped-bar" : "",
                )}
                style={{
                  backgroundColor:
                    STATUS_BAR_STYLES[status].style === "solid"
                      ? STATUS_BAR_STYLES[status].bg
                      : undefined,
                }}
                aria-hidden
              />
              <span>{STATUS_LABELS[status]}:</span>
              <span className="font-semibold text-foreground tabular">{byStatus[status] ?? 0}</span>
            </Link>
          );
        })}
      </div>
    </div>
  );
}

function DailyCapsuleBars({ daily }: { daily: { day: string; seconds: number }[] }) {
  const slice = daily.slice(-7);
  const maxSeconds = Math.max(1, ...slice.map((d) => d.seconds));
  const palette = ["#1f7a52", "#4db380", "#145338", "#22845a"];

  return (
    <div>
      <div
        className="flex h-44 items-end justify-between gap-2.5 pt-6 sm:gap-4"
        role="img"
        aria-label="Daily tracked time bars"
      >
        {slice.map((d, idx) => {
          const hasTime = d.seconds > 0;
          const heightPct = hasTime ? Math.max(24, Math.round((d.seconds / maxSeconds) * 100)) : 22;
          const weekday = formatWeekdayShort(d.day);
          const hoursLabel = hasTime ? `${(d.seconds / 3600).toFixed(1)}h` : "0h";

          return (
            <div
              key={d.day}
              className="group relative flex h-full flex-1 flex-col items-center justify-end gap-2"
              title={`${d.day}: ${formatDuration(d.seconds)}`}
            >
              <span
                className={cn(
                  "rounded-md border px-1.5 py-0.5 text-[10px] font-semibold tabular transition-opacity",
                  hasTime
                    ? "border-[#145338]/20 bg-white text-[#145338] shadow-2xs"
                    : "border-transparent text-muted-foreground opacity-0 group-hover:opacity-100",
                )}
              >
                {hoursLabel}
              </span>

              <div className="relative flex w-full max-w-[48px] flex-1 items-end">
                <div
                  className={cn(
                    "w-full rounded-full transition-all duration-300",
                    hasTime ? "shadow-xs" : "striped-bar",
                  )}
                  style={{
                    height: `${heightPct}%`,
                    backgroundColor: hasTime ? palette[idx % palette.length] : undefined,
                  }}
                />
              </div>

              <span className="text-[11px] font-medium text-muted-foreground" title={d.day}>
                {weekday}
              </span>
            </div>
          );
        })}
      </div>
      <div className="mt-4 flex items-center justify-between border-t border-border/60 pt-3 text-xs text-muted-foreground">
        <span>Total in shown days</span>
        <span className="font-semibold text-foreground tabular">
          {formatHours(slice.reduce((acc, item) => acc + item.seconds, 0))}
        </span>
      </div>
    </div>
  );
}

function formatWeekdayShort(dayStr: string): string {
  const d = new Date(`${dayStr}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return dayStr.slice(5);
  return new Intl.DateTimeFormat(undefined, { weekday: "short", timeZone: "UTC" }).format(d);
}

/**
 * 3. Semicircular Task Completion Progress Gauge inspired by Donezo's "Project Progress".
 * Computes real completion percentage from `counts.by_status.completed / counts.total`.
 */
export function TaskProgressGaugeCard({ counts }: { counts: DashboardPayload["counts"] }) {
  const patternId = useId();
  const total = counts.total;
  const completed = counts.by_status.completed ?? 0;
  const inProgress = (counts.by_status.in_progress ?? 0) + (counts.by_status.in_review ?? 0);
  const pending = (counts.by_status.todo ?? 0) + (counts.by_status.blocked ?? 0);

  const completedPct = total > 0 ? Math.round((completed / total) * 100) : 0;
  const activePct = total > 0 ? Math.round(((completed + inProgress) / total) * 100) : 0;

  // SVG semicircle math: radius 80, center (100, 95), arc length = pi * 80 ≈ 251.33
  const radius = 80;
  const circumference = Math.PI * radius;
  const completedDash = (completedPct / 100) * circumference;
  const activeDash = (activePct / 100) * circumference;

  return (
    <Card className="flex flex-col justify-between">
      <CardHeader className="pb-2">
        <CardTitle>Task Progress</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col items-center">
        <div className="relative flex w-full max-w-[230px] flex-col items-center pt-2">
          <svg
            viewBox="0 0 200 115"
            className="w-full overflow-visible"
            role="img"
            aria-label={`Task completion gauge: ${completedPct}% completed out of ${total} tasks`}
          >
            <defs>
              <pattern
                id={patternId}
                width="6"
                height="6"
                patternTransform="rotate(45 0 0)"
                patternUnits="userSpaceOnUse"
              >
                <line
                  x1="0"
                  y1="0"
                  x2="0"
                  y2="6"
                  stroke="#94a3b8"
                  strokeWidth="2.2"
                  strokeOpacity="0.45"
                />
              </pattern>
            </defs>

            {/* Striped Pending Track */}
            <path
              d="M 20 95 A 80 80 0 0 1 180 95"
              fill="none"
              stroke={`url(#${patternId})`}
              strokeWidth="24"
              strokeLinecap="round"
            />

            {/* In Progress + In Review segment (Deep Forest Green) */}
            {activePct > 0 ? (
              <path
                d="M 20 95 A 80 80 0 0 1 180 95"
                fill="none"
                stroke="#145338"
                strokeWidth="24"
                strokeLinecap="round"
                strokeDasharray={`${activeDash} ${circumference}`}
              />
            ) : null}

            {/* Completed segment (Vibrant Emerald Green) */}
            {completedPct > 0 ? (
              <path
                d="M 20 95 A 80 80 0 0 1 180 95"
                fill="none"
                stroke="#259062"
                strokeWidth="24"
                strokeLinecap="round"
                strokeDasharray={`${completedDash} ${circumference}`}
              />
            ) : null}
          </svg>

          <div className="-mt-11 text-center">
            <p className="tabular text-4xl font-bold tracking-tight text-foreground">
              {completedPct}%
            </p>
            <p className="mt-0.5 text-xs font-medium text-muted-foreground">
              {total === 0 ? "No tasks yet" : `${completed} of ${total} tasks completed`}
            </p>
          </div>
        </div>

        <div className="mt-5 flex flex-wrap items-center justify-center gap-4 text-xs text-muted-foreground">
          <span className="inline-flex items-center gap-1.5">
            <span className="h-3 w-3 rounded-full bg-[#259062]" aria-hidden />
            Completed ({completed})
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span className="h-3 w-3 rounded-full bg-[#145338]" aria-hidden />
            In Progress ({inProgress})
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span className="h-3 w-3 rounded-full striped-bar" aria-hidden />
            Pending ({pending})
          </span>
        </div>
      </CardContent>
    </Card>
  );
}

/**
 * 4. Attention & Reminders Card inspired by Donezo's "Reminders" card.
 * Displays real overdue, due-today, blocked, or carried-over work with a direct action button.
 */
export function AttentionCard({
  payload,
  taskListBase,
}: {
  payload: DashboardPayload;
  taskListBase: string;
}) {
  const counts = payload.counts;
  const overdueRows = payload.worklists?.overdue ?? [];
  const blockedRows = payload.worklists?.blocked ?? [];
  const carriedRows = payload.carried_over ?? [];
  const inProgressRows = payload.worklists?.in_progress ?? [];

  const featuredTask =
    overdueRows[0] ?? blockedRows[0] ?? carriedRows[0] ?? inProgressRows[0] ?? null;

  return (
    <Card className="flex flex-col justify-between">
      <CardHeader className="flex flex-row items-center justify-between pb-2">
        <CardTitle>Attention & Deadlines</CardTitle>
        {counts.overdue > 0 ? (
          <Badge variant="danger">{counts.overdue} overdue</Badge>
        ) : counts.due_today > 0 ? (
          <Badge variant="warning">{counts.due_today} due today</Badge>
        ) : (
          <Badge variant="success">On track</Badge>
        )}
      </CardHeader>

      <CardContent className="flex flex-1 flex-col justify-between gap-4 pt-1">
        {featuredTask ? (
          <div>
            <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
              {featuredTask.is_overdue ? "Overdue Task" : "Priority Focus"}
            </p>
            <Link
              href={`/tasks/${featuredTask.id}`}
              className="mt-1 block line-clamp-2 text-lg font-semibold leading-snug text-[#145338] hover:underline"
            >
              {featuredTask.title}
            </Link>
            <p className="mt-1 text-xs text-muted-foreground">
              {featuredTask.due_date
                ? `Due date: ${featuredTask.due_date}`
                : `Status: ${STATUS_LABELS[featuredTask.status]}`}
            </p>
          </div>
        ) : (
          <div>
            <p className="text-lg font-semibold leading-snug text-[#145338]">
              {counts.overdue > 0
                ? `${counts.overdue} overdue task${counts.overdue === 1 ? "" : "s"} need review`
                : counts.due_today > 0
                  ? `${counts.due_today} task${counts.due_today === 1 ? "" : "s"} due today`
                  : counts.blocked && counts.blocked > 0
                    ? `${counts.blocked} blocked task${counts.blocked === 1 ? "" : "s"} waiting`
                    : "No overdue or blocked work"}
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              {counts.open} open task{counts.open === 1 ? "" : "s"} · {counts.completed_in_range}{" "}
              completed in {payload.period_label ?? "range"}
            </p>
          </div>
        )}

        <div className="grid grid-cols-3 gap-2 rounded-xl bg-muted/70 p-2.5 text-center">
          <div>
            <p className="tabular text-sm font-bold text-foreground">{counts.due_today}</p>
            <p className="text-[10px] text-muted-foreground">Due Today</p>
          </div>
          <div>
            <p
              className={cn(
                "tabular text-sm font-bold",
                counts.overdue > 0 ? "text-destructive" : "text-foreground",
              )}
            >
              {counts.overdue}
            </p>
            <p className="text-[10px] text-muted-foreground">Overdue</p>
          </div>
          <div>
            <p
              className={cn(
                "tabular text-sm font-bold",
                (counts.blocked ?? 0) > 0 ? "text-warning" : "text-foreground",
              )}
            >
              {counts.blocked ?? 0}
            </p>
            <p className="text-[10px] text-muted-foreground">Blocked</p>
          </div>
        </div>

        <Link
          href={
            featuredTask
              ? `/tasks/${featuredTask.id}`
              : counts.overdue > 0
                ? `${taskListBase}?overdue=true`
                : taskListBase
          }
          className="block"
        >
          <Button className="w-full">
            {featuredTask ? (
              <>
                <ArrowUpRight className="h-4 w-4" aria-hidden />
                Open Focus Task
              </>
            ) : counts.overdue > 0 ? (
              <>
                <AlertTriangle className="h-4 w-4" aria-hidden />
                Review Overdue Tasks
              </>
            ) : (
              <>
                <CheckCircle2 className="h-4 w-4" aria-hidden />
                View Open Tasks
              </>
            )}
          </Button>
        </Link>
      </CardContent>
    </Card>
  );
}

/**
 * 5. Active Tasks Sidebar Widget inspired by Donezo's right-column "Project" list.
 * Lists real open/recent tasks with category/status icon badges, due dates, and "+ New" button.
 */
const TASK_ICON_COLORS = [
  "bg-[#eaf4ef] text-[#145338]",
  "bg-[#e0f2fe] text-[#0369a1]",
  "bg-[#fef3c7] text-[#b45309]",
  "bg-[#f3e8ff] text-[#7e22ce]",
  "bg-[#fce7f3] text-[#be185d]",
];

export function ActiveTasksWidget({
  tasks,
  canCreate,
  onNewTask,
  taskListBase,
}: {
  tasks: (Task | WorklistRow)[];
  canCreate: boolean;
  onNewTask: () => void;
  taskListBase: string;
}) {
  return (
    <Card className="flex flex-col justify-between">
      <CardHeader className="flex flex-row items-center justify-between pb-3">
        <CardTitle>Tasks</CardTitle>
        {canCreate ? (
          <Button variant="outline" size="sm" onClick={onNewTask}>
            <Plus className="h-3.5 w-3.5" aria-hidden />
            New
          </Button>
        ) : (
          <Link href={taskListBase}>
            <Button variant="outline" size="sm">
              View all
            </Button>
          </Link>
        )}
      </CardHeader>

      <CardContent>
        {tasks.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">
            No tasks to display yet.
          </p>
        ) : (
          <ul className="space-y-3">
            {tasks.slice(0, 5).map((task, idx) => (
              <li key={task.id}>
                <Link
                  href={`/tasks/${task.id}`}
                  className="group flex items-start gap-3 rounded-xl p-1.5 transition-colors hover:bg-muted/70"
                >
                  <span
                    className={cn(
                      "mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-xl text-xs font-bold",
                      TASK_ICON_COLORS[idx % TASK_ICON_COLORS.length],
                    )}
                    aria-hidden
                  >
                    <FolderKanban className="h-4 w-4" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-semibold text-foreground group-hover:text-[#145338]">
                      {task.title}
                    </p>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      {task.due_date ? (
                        <span className={task.is_overdue ? "font-medium text-destructive" : ""}>
                          {task.is_overdue ? `Overdue: ${task.due_date}` : `Due date: ${task.due_date}`}
                        </span>
                      ) : (
                        <span>Status: {STATUS_LABELS[task.status]}</span>
                      )}
                    </p>
                  </div>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

/**
 * 6. Dark Wavy Green Time Tracker Widget inspired by Donezo's bottom-right "Time Tracker".
 * Connects to the real `/timer/current` and `payload.working_now` endpoints.
 */
export function TimeTrackerWidget({
  workingNow,
  onInvalidated,
}: {
  workingNow: DashboardPayload["working_now"];
  onInvalidated: () => void;
}) {
  const timer = useRunningTimer();
  const myRunning = timer.data?.running?.[0];
  const activeColleague = workingNow[0];
  const activeStartedAt = myRunning?.started_at ?? activeColleague?.started_at;
  const elapsed = useElapsed(activeStartedAt, timer.data?.server_time);
  const [busy, setBusy] = useState(false);

  const pauseTimer = async () => {
    setBusy(true);
    try {
      await api("/timer/pause", {
        method: "POST",
        json: myRunning ? { log_id: myRunning.log_id } : {},
      });
      toast.success("Timer paused");
      onInvalidated();
    } catch (error) {
      toast.error(error instanceof ApiError ? error.message : "Could not pause");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col justify-between rounded-2xl p-5 time-tracker-card shadow-[0_8px_24px_rgba(7,34,22,0.24)]">
      <div className="flex items-center justify-between">
        <span className="text-sm font-semibold text-white/95">Time Tracker</span>
        {myRunning || activeColleague ? (
          <span className="inline-flex items-center gap-1.5 rounded-full bg-white/15 px-2.5 py-0.5 text-[10px] font-medium text-white">
            <span className="h-1.5 w-1.5 animate-ping rounded-full bg-[#4db380]" />
            Live
          </span>
        ) : (
          <Link href="/time" className="text-xs text-white/75 hover:text-white hover:underline">
            History
          </Link>
        )}
      </div>

      <div className="my-4 text-center">
        <p className="tabular text-4xl font-bold tracking-wider text-white sm:text-[40px]">
          {formatClock(myRunning || activeColleague ? elapsed : 0)}
        </p>
        <p className="mt-1.5 truncate px-2 text-xs text-white/75">
          {myRunning
            ? myRunning.task_title
            : activeColleague
              ? `${activeColleague.user.full_name} · ${activeColleague.task.title}`
              : "No active timer running right now"}
        </p>
      </div>

      <div className="flex items-center justify-center gap-3">
        {myRunning || activeColleague ? (
          <>
            <button
              type="button"
              onClick={() => void pauseTimer()}
              disabled={busy}
              aria-label="Pause running timer"
              title="Pause timer"
              className="flex h-11 w-11 items-center justify-center rounded-full bg-white text-[#145338] shadow-md transition-transform hover:scale-105 disabled:opacity-50"
            >
              <Pause className="h-5 w-5 fill-current" aria-hidden />
            </button>
            <Link
              href={`/tasks/${myRunning ? myRunning.task_id : activeColleague.task.id}`}
              aria-label="Open task for running timer"
              title="Open task"
              className="flex h-11 w-11 items-center justify-center rounded-full bg-[#e5484d] text-white shadow-md transition-transform hover:scale-105"
            >
              <Square className="h-4 w-4 fill-current" aria-hidden />
            </Link>
          </>
        ) : (
          <Link
            href="/my-tasks"
            className="inline-flex items-center gap-2 rounded-full bg-white/15 px-4 py-2 text-xs font-semibold text-white backdrop-blur-xs transition-colors hover:bg-white/25"
          >
            <Play className="h-3.5 w-3.5 fill-current" aria-hidden />
            Select a task to start timer
          </Link>
        )}
      </div>
    </div>
  );
}

/**
 * 7. Team Collaboration / Working Now Widget inspired by Donezo's "Team Collaboration" card.
 * In Executive mode, shows real `payload.members` workload + running timers (`payload.working_now`).
 * In Personal mode, shows real `payload.worklists` tasks and running timer sessions.
 */
export function TeamCollaborationCard({
  payload,
  mode,
  canManageUsers,
  onInvalidated,
}: {
  payload: DashboardPayload;
  mode: "executive" | "personal";
  canManageUsers: boolean;
  onInvalidated: () => void;
}) {
  const timer = useRunningTimer();
  const workingByUserId = new Map(
    payload.working_now.map((row) => [row.user.id, row]),
  );

  if (mode === "executive" && payload.members) {
    return (
      <Card>
        <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2 pb-3">
          <div>
            <CardTitle>Team Collaboration</CardTitle>
            <p className="mt-0.5 text-xs text-muted-foreground">
              People are listed by name. Taskssort does not rank anyone by output.
            </p>
          </div>
          {canManageUsers ? (
            <Link href="/users">
              <Button variant="outline" size="sm">
                <Plus className="h-3.5 w-3.5" aria-hidden />
                Manage Users
              </Button>
            </Link>
          ) : (
            <Link href="/team-tasks">
              <Button variant="outline" size="sm">
                Team Board
              </Button>
            </Link>
          )}
        </CardHeader>

        <CardContent>
          {payload.members.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">
              No work assigned yet.
            </p>
          ) : (
            <ul className="divide-y divide-border/60">
              {payload.members.map((member) => {
                const activeSession = workingByUserId.get(member.user.id);
                return (
                  <li
                    key={member.user.id}
                    className="flex flex-wrap items-center justify-between gap-3 py-3 first:pt-0 last:pb-0"
                  >
                    <div className="flex min-w-0 items-center gap-3">
                      <Avatar person={member.user} size="md" />
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <Link
                            href={`/team-tasks?assignee_id=${member.user.id}`}
                            className="truncate text-sm font-semibold text-foreground hover:text-[#145338] hover:underline"
                          >
                            {displayName(member.user)}
                          </Link>
                          <span className="text-[11px] text-muted-foreground">
                            {roleLabel(member.user.role)}
                          </span>
                        </div>
                        <p className="truncate text-xs text-muted-foreground">
                          {activeSession ? (
                            <>
                              Working on{" "}
                              <Link
                                href={`/tasks/${activeSession.task.id}`}
                                className="font-medium text-foreground hover:underline"
                              >
                                {activeSession.task.title}
                              </Link>
                            </>
                          ) : (
                            <>
                              <span className="font-medium text-foreground tabular">
                                {member.open_tasks}
                              </span>{" "}
                              open task{member.open_tasks === 1 ? "" : "s"} ·{" "}
                              <span className="tabular">
                                {formatDuration(member.tracked_seconds)}
                              </span>{" "}
                              tracked in range
                            </>
                          )}
                        </p>
                      </div>
                    </div>

                    <div className="flex shrink-0 items-center gap-2">
                      {activeSession ? (
                        <Badge variant="success">Working Now</Badge>
                      ) : member.open_tasks > 0 ? (
                        <Badge variant="warning">{member.open_tasks} Open</Badge>
                      ) : (
                        <Badge variant="muted">Clear</Badge>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}

          {payload.working_now.length > 0 ? (
            <div className="mt-4 border-t border-border/60 pt-3">
              <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                Active Timers Right Now
              </p>
              <ul className="space-y-2">
                {payload.working_now.map((row) => (
                  <WorkingTimerRow
                    key={row.log_id}
                    row={row}
                    serverTime={timer.data?.server_time}
                    onPause={onInvalidated}
                  />
                ))}
              </ul>
            </div>
          ) : null}
        </CardContent>
      </Card>
    );
  }

  // Personal mode: show current worklists & running timers
  const inProgress = payload.worklists?.in_progress ?? [];
  const completed = payload.worklists?.completed ?? [];
  const combined = [...inProgress, ...completed].slice(0, 5);

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between pb-3">
        <div>
          <CardTitle>My Worklist</CardTitle>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Tasks currently in progress and recently completed
          </p>
        </div>
        <Link href="/my-tasks">
          <Button variant="outline" size="sm">
            All My Tasks
          </Button>
        </Link>
      </CardHeader>
      <CardContent>
        {combined.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">
            No tasks in progress or completed yet.
          </p>
        ) : (
          <ul className="divide-y divide-border/60">
            {combined.map((row) => (
              <li
                key={row.id}
                className="flex flex-wrap items-center justify-between gap-3 py-3 first:pt-0 last:pb-0"
              >
                <div className="flex min-w-0 items-center gap-3">
                  {row.assignee ? (
                    <Avatar person={row.assignee} size="sm" />
                  ) : (
                    <span className="flex h-7 w-7 items-center justify-center rounded-full bg-[#eaf4ef] text-xs font-bold text-[#145338]">
                      <Timer className="h-3.5 w-3.5" aria-hidden />
                    </span>
                  )}
                  <div className="min-w-0">
                    <Link
                      href={`/tasks/${row.id}`}
                      className="block truncate text-sm font-semibold text-foreground hover:text-[#145338] hover:underline"
                    >
                      {row.title}
                    </Link>
                    <p className="text-xs text-muted-foreground">
                      {row.due_date ? `Due ${row.due_date}` : "No due date"}
                    </p>
                  </div>
                </div>
                <StatusBadge status={row.status} />
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

export function WorkingTimerRow({
  row,
  serverTime,
  onPause,
}: {
  row: DashboardPayload["working_now"][number];
  serverTime?: string;
  onPause: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const elapsed = useElapsed(row.started_at, serverTime);

  const pause = async () => {
    setBusy(true);
    try {
      await api("/timer/pause", { method: "POST", json: { log_id: row.log_id } });
      toast.success("Timer paused");
      onPause();
    } catch (error) {
      toast.error(error instanceof ApiError ? error.message : "Could not pause");
    } finally {
      setBusy(false);
    }
  };

  return (
    <li className="flex flex-wrap items-center gap-2.5 rounded-xl bg-muted/60 px-3 py-2 text-sm">
      <span className="relative flex h-2 w-2">
        <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-success opacity-75" />
        <span className="relative h-2 w-2 rounded-full bg-success" />
      </span>
      <span className="font-medium">{row.user.full_name}</span>
      <Link href={`/tasks/${row.task.id}`} className="min-w-0 flex-1 truncate hover:underline">
        {row.task.title}
      </Link>
      {row.is_stale ? <Badge variant="warning">Stale</Badge> : null}
      <span className="tabular text-xs font-semibold text-muted-foreground">
        {formatDuration(elapsed)}
      </span>
      <Button variant="outline" size="sm" onClick={pause} loading={busy}>
        <Pause className="h-3.5 w-3.5" aria-hidden />
        Pause
      </Button>
    </li>
  );
}
