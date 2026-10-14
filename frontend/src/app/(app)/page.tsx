"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Pause, Play, RefreshCw } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";
import { toast } from "sonner";

import { PageHeader, roleLabel } from "@/components/app-shell";
import { Avatar, displayName } from "@/components/avatar";
import { useElapsed, useRunningTimer } from "@/components/timer-bar";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, EmptyState, ErrorState, Spinner } from "@/components/ui/card";
import { Badge } from "@/components/ui/form";
import { api, ApiError } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { formatDuration, formatHours } from "@/lib/format";
import { STATUS_LABELS, type DashboardPayload, type TaskStatus, type WorklistRow } from "@/lib/types";

const STATUS_COLORS: Record<TaskStatus, string> = {
  todo: "var(--color-muted-foreground)",
  in_progress: "var(--color-primary)",
  blocked: "var(--color-destructive)",
  in_review: "var(--color-warning)",
  completed: "var(--color-success)",
};

export default function DashboardPage() {
  const { capabilities } = useAuth();
  const client = useQueryClient();

  const mode = capabilities?.can_view_executive_dashboard ? "executive" : "personal";
  const [period, setPeriod] = useState("week");

  const data = useQuery({
    queryKey: ["dashboard", mode, period],
    queryFn: () => api<DashboardPayload>(`/dashboard/${mode}?period=${period}`),
    refetchInterval: 60_000, // FR-DASH-007
    refetchIntervalInBackground: false,
  });

  // only poll while the tab is visible
  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState === "visible") void client.invalidateQueries({ queryKey: ["dashboard"] });
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, [client]);

  const title =
    mode === "executive"
      ? capabilities?.can_review && capabilities?.can_view_team && capabilities?.can_create_tasks === false
        ? "Executive overview"
        : "Company overview"
      : "My day";

  if (data.isLoading) return <Spinner label="Loading dashboard" />;
  if (data.isError) {
    return (
      <ErrorState
        message={data.error instanceof ApiError ? data.error.message : "The dashboard could not be loaded."}
        onRetry={() => void data.refetch()}
      />
    );
  }

  const payload = data.data;
  if (!payload) return <Spinner label="Loading dashboard" />;
  const counts = payload.counts;
  const isEmpty = counts.total === 0;
  const isCompany = mode === "executive";
  const lists = payload.worklists;

  // A CEO/lead reading a company-wide number must land on the company list.
  // Pointing them at "My Tasks" silently shows them their own work instead.
  const taskListBase = isCompany ? "/team-tasks" : "/my-tasks";

  // The card says "completed today" when the period is today, so the list it
  // opens has to be filtered to the same window or the number and the rows
  // disagree. "Completed" is measured on completed_at, so that is the date
  // filter the API filters on.
  const range = payload.range;
  const completedWindow =
    period === "today" && range
      ? `&completed_from=${String(range.from).slice(0, 10)}&completed_to=${String(range.to).slice(0, 10)}`
      : period !== "week" && range
        ? `&completed_from=${String(range.from).slice(0, 10)}&completed_to=${String(range.to).slice(0, 10)}`
        : "";

  return (
    <>
      <PageHeader
        title={title}
        description={`${payload.period_label ?? "the selected period"} · every figure is computed from live records`}
        actions={
          <>
            <Select
              value={period}
              onChange={(e) => setPeriod(e.target.value)}
              className="h-9 w-auto"
            >
              <option value="today">Today</option>
              <option value="week">Last 7 days</option>
              <option value="month">Last 30 days</option>
              <option value="quarter">Last 90 days</option>
            </Select>
            <Button variant="outline" onClick={() => void data.refetch()}>
              <RefreshCw className="h-4 w-4" aria-hidden />
              Refresh
            </Button>
          </>
        }
      />

      {isEmpty && mode === "personal" ? (
        <EmptyState
          title="No tasks assigned to you yet"
          description="Once your team lead assigns work, or you add a task for yourself, it will show up here."
          action={
            capabilities?.can_create_tasks ? (
              <Link href="/my-tasks">
                <Button className="mt-2">Create the first task</Button>
              </Link>
            ) : null
          }
        />
      ) : (
        <>
          <div className="mb-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <KpiCard
              label="In Progress"
              value={counts.in_progress ?? counts.by_status.in_progress ?? 0}
              href={`${taskListBase}?status=in_progress`}
              hint="Being worked on now"
            />
            <KpiCard
              label="Completed"
              value={counts.completed_in_range}
              href={`${taskListBase}?status=completed${completedWindow}`}
              hint={`Finished ${payload.period_label ?? "in range"}`}
              tone="success"
            />
            <KpiCard
              label="Tracked time"
              value={formatHours(counts.tracked_seconds)}
              href="/time"
              hint={isCompany ? "Who spent it, and on what" : "Your hours, task by task"}
            />
            <KpiCard
              label="Open tasks"
              value={counts.open}
              href={taskListBase}
              hint="Everything not completed"
            />
          </div>

          <Card className="mb-5">
            <CardHeader>
              <CardTitle>Workload</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="stacked-bar" role="img" aria-label="Distribution of tasks by status">
                {(Object.keys(STATUS_LABELS) as TaskStatus[]).map((status) => {
                  const value = counts.by_status[status] ?? 0;
                  if (value === 0) return null;
                  return (
                    <span
                      key={status}
                      style={{ width: `${(value / Math.max(1, counts.total)) * 100}%`, background: STATUS_COLORS[status] }}
                      title={`${STATUS_LABELS[status]}: ${value}`}
                    />
                  );
                })}
              </div>
              <div className="mt-3 flex flex-wrap gap-x-4 gap-y-2">
                {(Object.keys(STATUS_LABELS) as TaskStatus[]).map((status) => (
                  <Link
                    key={status}
                    href={`/team-tasks?status=${status}`}
                    className="inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground"
                  >
                    <span
                      className="h-2 w-2 rounded-full"
                      style={{ background: STATUS_COLORS[status] }}
                      aria-hidden
                    />
                    {STATUS_LABELS[status]} · {counts.by_status[status] ?? 0}
                  </Link>
                ))}
              </div>
            </CardContent>
          </Card>

          <WorkingNow rows={payload.working_now} />

          {mode === "executive" && payload.members ? (
            <Card className="mt-5">
              <CardHeader>
                <CardTitle>Team workload</CardTitle>
              </CardHeader>
              <CardContent>
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-border text-left text-xs text-muted-foreground">
                      <th className="py-2 font-medium">Person</th>
                      <th className="py-2 font-medium">Role</th>
                      <th className="py-2 text-right font-medium">Open tasks</th>
                      <th className="py-2 text-right font-medium">Tracked in range</th>
                    </tr>
                  </thead>
                  <tbody>
                    {payload.members.length === 0 ? (
                      <tr>
                        <td colSpan={4} className="py-6 text-center text-muted-foreground">
                          No work assigned yet.
                        </td>
                      </tr>
                    ) : (
                      payload.members.map((member) => (
                        <tr key={member.user.id} className="border-b border-border last:border-b-0">
                          <td className="py-2">
                            <span className="flex items-center gap-2">
                              <Avatar person={member.user} size="xs" />
                              <span className="font-medium">{displayName(member.user)}</span>
                            </span>
                          </td>
                          <td className="py-2 text-muted-foreground">{roleLabel(member.user.role)}</td>
                          <td className="tabular py-2 text-right">{member.open_tasks}</td>
                          <td className="tabular py-2 text-right">
                            {formatDuration(member.tracked_seconds)}
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
                <p className="mt-3 text-xs text-muted-foreground">
                  People are listed by name. MarketingOS does not rank anyone by output.
                </p>
              </CardContent>
            </Card>
          ) : null}

          {payload.daily && payload.daily.length > 0 ? (
            <Card className="mt-5">
              <CardHeader>
                <CardTitle>My time by day</CardTitle>
              </CardHeader>
              <CardContent>
                <DailyBars daily={payload.daily} />
              </CardContent>
            </Card>
          ) : null}

          {payload.carried_over && payload.carried_over.length > 0 ? (
            <Card className="mt-5 border-warning/40">
              <CardHeader>
                <CardTitle>Carried over from before today</CardTitle>
              </CardHeader>
              <CardContent>
                <p className="mb-3 text-sm text-muted-foreground">
                  These were already open yesterday and are still not done. They did not fall
                  off the list — they were waiting.
                </p>
                <ul className="flex flex-col gap-2">
                  {payload.carried_over.map((row) => (
                    <li key={row.id} className="flex flex-wrap items-center gap-2 text-sm">
                      <Badge variant={row.is_overdue ? "warning" : "outline"}>
                        {row.is_overdue ? `Overdue ${row.due_date}` : STATUS_LABELS[row.status]}
                      </Badge>
                      <Link href={`/tasks/${row.id}`} className="min-w-0 flex-1 hover:underline">
                        {row.title}
                      </Link>
                      {!row.is_overdue && row.due_date ? (
                        <span className="text-xs text-muted-foreground">due {row.due_date}</span>
                      ) : null}
                    </li>
                  ))}
                </ul>
              </CardContent>
            </Card>
          ) : null}

          {lists ? (
            <>
              <TaskSection
                title="In Progress"
                tone="default"
                rows={lists.in_progress}
              />
              <TaskSection
                title="Overdue"
                tone="danger"
                rows={lists.overdue}
              />
              <TaskSection
                title="Blocked"
                tone="warning"
                rows={lists.blocked}
              />
              <TaskSection
                title="Completed"
                tone="success"
                rows={lists.completed}
              />
            </>
          ) : null}
        </>
      )}
    </>
  );
}

function Select({
  value,
  onChange,
  children,
  className,
}: {
  value: string;
  onChange: (e: React.ChangeEvent<HTMLSelectElement>) => void;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <select
      value={value}
      onChange={onChange}
      className={`rounded-md border border-input bg-card px-3 text-sm ${className ?? ""}`}
    >
      {children}
    </select>
  );
}

function KpiCard({
  label,
  value,
  hint,
  href,
  tone = "default",
}: {
  label: string;
  value: number | string;
  hint: string;
  href: string;
  tone?: "default" | "danger" | "success";
}) {
  return (
    <Link href={href} className="block">
      <Card className="h-full transition-colors hover:border-primary/50">
        <CardHeader className="pb-2">
          <CardTitle className="text-xs font-medium text-muted-foreground">{label}</CardTitle>
        </CardHeader>
        <CardContent>
          <p
            className={`text-2xl font-semibold tabular ${
              tone === "danger"
                ? "text-destructive"
                : tone === "success"
                  ? "text-success"
                  : "text-foreground"
            }`}
          >
            {value}
          </p>
          <p className="mt-1 text-xs text-muted-foreground">{hint}</p>
        </CardContent>
      </Card>
    </Link>
  );
}

function TaskSection({
  title,
  tone,
  rows,
}: {
  title: string;
  tone: "default" | "danger" | "warning" | "success";
  rows: WorklistRow[];
}) {
  if (rows.length === 0) return null;
  const border =
    tone === "danger"
      ? "border-destructive/40"
      : tone === "warning"
        ? "border-warning/40"
        : tone === "success"
          ? "border-success/30"
          : "";

  return (
    <Card className={`mt-5 ${border}`}>
      <CardHeader>
        <CardTitle>
          {title} <span className="text-sm font-normal text-muted-foreground">({rows.length})</span>
        </CardTitle>
      </CardHeader>
      <CardContent>
        <ul className="flex flex-col gap-2">
          {rows.map((row) => (
            <li key={row.id} className="flex flex-wrap items-center gap-2 text-sm">
              {row.assignee ? <Avatar person={row.assignee} size="xs" /> : null}
              <Link href={`/tasks/${row.id}`} className="min-w-0 flex-1 hover:underline">
                {row.title}
              </Link>
              {row.is_overdue ? (
                <Badge variant="warning">overdue {row.due_date}</Badge>
              ) : row.due_date ? (
                <span className="text-xs text-muted-foreground">due {row.due_date}</span>
              ) : null}
              {row.assignee ? (
                <span className="text-xs text-muted-foreground">{displayName(row.assignee)}</span>
              ) : (
                <span className="text-xs text-muted-foreground">Unassigned</span>
              )}
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}

function WorkingNow({ rows }: { rows: DashboardPayload["working_now"] }) {
  const client = useQueryClient();
  const timer = useRunningTimer();
  const invalidate = () => client.invalidateQueries();

  if (rows.length === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Working now</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">Nobody has a running timer right now.</p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Working now</CardTitle>
      </CardHeader>
      <CardContent>
        <ul className="flex flex-col gap-3">
          {rows.map((row) => (
            <WorkingRow key={row.log_id} row={row} serverTime={timer.data?.server_time} onPause={invalidate} />
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}

function WorkingRow({
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
      await api("/timer/pause", { method: "POST", json: {} });
      toast.success("Timer paused");
      onPause();
    } catch (error) {
      toast.error(error instanceof ApiError ? error.message : "Could not pause");
    } finally {
      setBusy(false);
    }
  };

  return (
    <li className="flex flex-wrap items-center gap-3">
      <span className="relative flex h-2 w-2">
        <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-success opacity-75" />
        <span className="relative h-2 w-2 rounded-full bg-success" />
      </span>
      <span className="font-medium">{row.user.full_name}</span>
      <Link href={`/tasks/${row.task.id}`} className="min-w-0 flex-1 truncate text-sm hover:underline">
        {row.task.title}
      </Link>
      {row.is_stale ? <Badge variant="warning">Stale</Badge> : null}
      <span className="tabular text-sm text-muted-foreground">{formatDuration(elapsed)}</span>
      <Button variant="outline" size="sm" onClick={pause} loading={busy}>
        <Pause className="h-4 w-4" aria-hidden />
        Pause
      </Button>
      <Link href={`/tasks/${row.task.id}`}>
        <Button variant="ghost" size="sm">
          <Play className="h-4 w-4" aria-hidden />
          Open
        </Button>
      </Link>
    </li>
  );
}

function DailyBars({ daily }: { daily: { day: string; seconds: number }[] }) {
  const max = Math.max(1, ...daily.map((d) => d.seconds));
  return (
    <div className="flex h-32 items-end gap-2">
      {daily.map((d) => (
        <div key={d.day} className="flex flex-1 flex-col items-center gap-1">
          <span className="tabular text-[10px] text-muted-foreground">
            {d.seconds > 0 ? `${Math.round(d.seconds / 360) / 10}h` : ""}
          </span>
          <div
            className="w-full rounded-t bg-primary/80"
            style={{ height: `${Math.max(2, (d.seconds / max) * 100)}%` }}
            title={`${d.day}: ${formatDuration(d.seconds)}`}
          />
          <span className="text-[10px] text-muted-foreground">{d.day.slice(5)}</span>
        </div>
      ))}
    </div>
  );
}
