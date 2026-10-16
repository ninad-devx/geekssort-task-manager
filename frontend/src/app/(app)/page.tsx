"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, RefreshCw } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";

import { PageHeader } from "@/components/app-shell";
import { Avatar, displayName } from "@/components/avatar";
import {
  ActiveTasksWidget,
  AnalyticsChartCard,
  AttentionCard,
  StatCard,
  TaskProgressGaugeCard,
  TeamCollaborationCard,
  TimeTrackerWidget,
} from "@/components/dashboard-widgets";
import { CreateTaskDialog } from "@/components/tasks/task-dialogs";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, EmptyState, ErrorState, Spinner } from "@/components/ui/card";
import { Badge } from "@/components/ui/form";
import { api, ApiError } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { formatHours } from "@/lib/format";
import {
  STATUS_LABELS,
  type DashboardPayload,
  type TaskList,
  type WorklistRow,
} from "@/lib/types";

export default function DashboardPage() {
  const { capabilities } = useAuth();
  const client = useQueryClient();

  const mode = capabilities?.can_view_executive_dashboard ? "executive" : "personal";
  const [period, setPeriod] = useState("week");
  const [createOpen, setCreateOpen] = useState(false);

  const data = useQuery({
    queryKey: ["dashboard", mode, period],
    queryFn: () => api<DashboardPayload>(`/dashboard/${mode}?period=${period}`),
    refetchInterval: 60_000, // FR-DASH-007
    refetchIntervalInBackground: false,
  });

  // Fetch recent open tasks for the right-column Tasks widget when in executive mode
  // (personal mode already includes `payload.worklists`)
  const recentTasks = useQuery({
    queryKey: ["tasks", "dashboard-recent", mode],
    queryFn: () => api<TaskList>("/tasks?page=1&page_size=6&sort=due&order=asc"),
    enabled: mode === "executive",
    staleTime: 30_000,
  });

  // only poll while the tab is visible
  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState === "visible") {
        void client.invalidateQueries({ queryKey: ["dashboard"] });
      }
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, [client]);

  const title =
    mode === "executive"
      ? capabilities?.can_review &&
        capabilities?.can_view_team &&
        capabilities?.can_create_tasks === false
        ? "Executive Overview"
        : "Dashboard"
      : "My Day";

  if (data.isLoading) return <Spinner label="Loading dashboard" />;
  if (data.isError) {
    return (
      <ErrorState
        message={
          data.error instanceof ApiError
            ? data.error.message
            : "The dashboard could not be loaded."
        }
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

  const invalidateAll = () => {
    void client.invalidateQueries({ queryKey: ["dashboard"] });
    void client.invalidateQueries({ queryKey: ["tasks"] });
    void client.invalidateQueries({ queryKey: ["timer"] });
  };

  // Assemble real tasks for the right-hand Tasks widget
  const widgetTasks =
    mode === "executive"
      ? (recentTasks.data?.items ?? [])
      : [
          ...(lists?.in_progress ?? []),
          ...(lists?.overdue ?? []),
          ...(lists?.blocked ?? []),
          ...(lists?.completed ?? []),
        ].filter(
          (row, idx, arr) => arr.findIndex((candidate) => candidate.id === row.id) === idx,
        );

  const inProgressCount = counts.in_progress ?? counts.by_status.in_progress ?? 0;

  return (
    <>
      <PageHeader
        title={title}
        description={`Plan, prioritize, and accomplish your tasks with ease · ${payload.period_label ?? "the selected period"}`}
        actions={
          <>
            {capabilities?.can_create_tasks ? (
              <Button onClick={() => setCreateOpen(true)}>
                <Plus className="h-4 w-4" aria-hidden />
                Add Task
              </Button>
            ) : null}
            <Select
              value={period}
              onChange={(e) => setPeriod(e.target.value)}
              aria-label="Dashboard period"
              className="h-10 w-auto"
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
              <Button className="mt-2" onClick={() => setCreateOpen(true)}>
                Create the first task
              </Button>
            ) : null
          }
        />
      ) : (
        <>
          {/* Row 1: 4 Donezo-inspired Statistics Cards */}
          <div className="mb-5 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <StatCard
              featured
              label="Total Tasks"
              value={counts.total}
              badgeText={`${counts.open} open`}
              hint="Active across workspace"
              href={taskListBase}
            />
            <StatCard
              label="Completed Tasks"
              value={counts.completed_in_range}
              badgeText={`${counts.by_status.completed ?? 0} total`}
              hint={`Finished ${payload.period_label ?? "in range"}`}
              href={`${taskListBase}?status=completed${completedWindow}`}
              tone="success"
            />
            <StatCard
              label="In Progress"
              value={inProgressCount}
              badgeText={
                (counts.by_status.in_review ?? 0) > 0
                  ? `${counts.by_status.in_review} in review`
                  : undefined
              }
              hint="Being worked on now"
              href={`${taskListBase}?status=in_progress`}
            />
            <StatCard
              label="Tracked Time"
              value={formatHours(counts.tracked_seconds)}
              badgeText={counts.overdue > 0 ? `${counts.overdue} overdue` : undefined}
              hint={
                counts.overdue > 0
                  ? `${counts.due_today} due today`
                  : isCompany
                    ? "Company hours in range"
                    : "Your hours in range"
              }
              href="/time"
              tone={counts.overdue > 0 ? "danger" : "default"}
            />
          </div>

          {/* Main Dashboard Bento Grid matching Donezo layout */}
          <div className="grid gap-5 xl:grid-cols-[1fr_320px]">
            {/* Left / Center 2-column area */}
            <div className="flex flex-col gap-5">
              {/* Middle Row: Analytics Chart + Attention/Reminders */}
              <div className="grid gap-5 lg:grid-cols-[1.35fr_1fr]">
                <AnalyticsChartCard
                  payload={payload}
                  taskListBase={taskListBase}
                  completedWindow={completedWindow}
                />
                <AttentionCard payload={payload} taskListBase={taskListBase} />
              </div>

              {/* Bottom Row: Team Collaboration / Worklist + Semicircular Task Progress */}
              <div className="grid gap-5 lg:grid-cols-[1.35fr_1fr]">
                <TeamCollaborationCard
                  payload={payload}
                  mode={mode}
                  canManageUsers={!!capabilities?.can_manage_users}
                  onInvalidated={invalidateAll}
                />
                <TaskProgressGaugeCard counts={counts} />
              </div>
            </div>

            {/* Right Column: Tasks list + Dark Wavy Time Tracker */}
            <div className="flex flex-col gap-5">
              <ActiveTasksWidget
                tasks={widgetTasks}
                canCreate={!!capabilities?.can_create_tasks}
                onNewTask={() => setCreateOpen(true)}
                taskListBase={taskListBase}
              />
              <TimeTrackerWidget
                workingNow={payload.working_now}
                onInvalidated={invalidateAll}
              />
            </div>
          </div>

          {/* Carried-over banner & full worklist sections preserved for personal mode */}
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
                      <Link href={`/tasks/${row.id}`} className="min-w-0 flex-1 font-medium hover:underline">
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
            <div className="mt-5 grid gap-5 md:grid-cols-2">
              <TaskSection title="In Progress" tone="default" rows={lists.in_progress} />
              <TaskSection title="Overdue" tone="danger" rows={lists.overdue} />
              <TaskSection title="Blocked" tone="warning" rows={lists.blocked} />
              <TaskSection title="Completed" tone="success" rows={lists.completed} />
            </div>
          ) : null}
        </>
      )}

      {capabilities?.can_create_tasks ? (
        <CreateTaskDialog
          open={createOpen}
          onClose={() => setCreateOpen(false)}
          onDone={invalidateAll}
          showAssignee={!!capabilities?.can_view_team}
        />
      ) : null}
    </>
  );
}

function Select({
  value,
  onChange,
  children,
  className,
  ...props
}: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select
      value={value}
      onChange={onChange}
      className={`rounded-full border border-[#145338]/30 bg-card px-4 text-sm font-medium text-foreground shadow-2xs transition-colors hover:border-[#145338] focus:outline-none focus:ring-2 focus:ring-ring ${className ?? ""}`}
      {...props}
    >
      {children}
    </select>
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
    <Card className={border}>
      <CardHeader>
        <CardTitle>
          {title}{" "}
          <span className="text-sm font-normal text-muted-foreground">({rows.length})</span>
        </CardTitle>
      </CardHeader>
      <CardContent>
        <ul className="flex flex-col gap-2.5">
          {rows.map((row) => (
            <li key={row.id} className="flex flex-wrap items-center gap-2 text-sm">
              {row.assignee ? <Avatar person={row.assignee} size="xs" /> : null}
              <Link href={`/tasks/${row.id}`} className="min-w-0 flex-1 font-medium hover:underline">
                {row.title}
              </Link>
              {row.is_overdue ? (
                <Badge variant="danger">overdue {row.due_date}</Badge>
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
