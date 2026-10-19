"use client";

import { useQuery } from "@tanstack/react-query";
import {
  Activity,
  ArrowLeft,
  CalendarCheck,
  CheckCircle2,
  Clock,
  FolderKanban,
  History,
  Timer,
} from "lucide-react";
import Link from "next/link";
import { use, useState } from "react";

import { PageHeader, roleLabel } from "@/components/app-shell";
import { Avatar, displayName } from "@/components/avatar";
import { useElapsed } from "@/components/timer-bar";
import { StatusBadge } from "@/components/tasks/task-ui";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, ErrorState, Spinner } from "@/components/ui/card";
import { Badge, Select } from "@/components/ui/form";
import { api, ApiError, qs } from "@/lib/api";
import {
  formatDayLabel,
  formatDuration,
  formatHours,
  formatReadable,
  todayLocal,
} from "@/lib/format";
import { EVENT_LABELS, type UserProfile, type WorklistRow } from "@/lib/types";
import { cn } from "@/lib/utils";

const RANGES = [
  { value: 7, label: "Last 7 days" },
  { value: 14, label: "Last 14 days" },
  { value: 30, label: "Last 30 days" },
  { value: 90, label: "Last 90 days" },
];

/**
 * One person, in full: who they are, what is on their plate right now, their
 * day-by-day record, and what they have been doing.
 *
 * The same page serves both audiences the request named. A member opening their
 * own link and a lead opening theirs get identical numbers -- the only
 * difference is that the lead reached it from the team board rather than the
 * top bar. A separate "manager view" of the same figures is how the two drift
 * apart.
 */
export default function UserProfilePage({ params }: PageProps<"/users/[id]">) {
  const { id: rawId } = use(params);
  const userId = Number(rawId);
  const [days, setDays] = useState(30);

  const profile = useQuery({
    queryKey: ["profile", userId, days],
    queryFn: () => api<UserProfile>(`/users/${userId}/profile${qs({ days })}`),
    enabled: Number.isFinite(userId),
  });

  if (!Number.isFinite(userId)) {
    return <ErrorState message="That is not a valid user id." />;
  }
  if (profile.isLoading) return <Spinner label="Loading profile" />;
  if (profile.isError || !profile.data) {
    return (
      <ErrorState
        message={
          profile.error instanceof ApiError
            ? profile.error.message
            : "Could not load this profile."
        }
        onRetry={() => void profile.refetch()}
      />
    );
  }

  const data = profile.data;
  const counts = data.counts;
  const person = data.user;
  const today = todayLocal();

  return (
    <>
      <PageHeader
        title={displayName(person)}
        description={`${roleLabel(person.role)}${person.is_active ? "" : " · Deactivated"}${
          data.is_self ? " · This is you" : ""
        }`}
        actions={
          <>
            <Link href="/people">
              <Button variant="outline">
                <ArrowLeft className="h-4 w-4" aria-hidden />
                All people
              </Button>
            </Link>
            <Select
              value={days}
              onChange={(e) => setDays(Number(e.target.value))}
              aria-label="Activity window"
              className="h-10 w-auto rounded-full px-4"
            >
              {RANGES.map((range) => (
                <option key={range.value} value={range.value}>
                  {range.label}
                </option>
              ))}
            </Select>
          </>
        }
      />

      {/* Identity */}
      <Card className="mb-5">
        <CardContent className="flex flex-wrap items-center gap-5 p-5">
          <Avatar person={person} size="md" className="h-16 w-16 text-lg" />
          <div className="min-w-0 flex-1">
            <p className="truncate text-xl font-bold text-foreground">{displayName(person)}</p>
            <p className="text-sm text-muted-foreground">{person.full_name}</p>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <Badge variant="default">{roleLabel(person.role)}</Badge>
              {person.can_review ? <Badge variant="outline">Reviewer</Badge> : null}
              {person.is_admin ? <Badge variant="outline">Admin</Badge> : null}
              {!person.is_active ? <Badge variant="danger">Deactivated</Badge> : null}
              <span className="text-xs text-muted-foreground">
                Joined {formatReadable(person.created_at).split(",")[0]}
              </span>
            </div>
          </div>
          <RunningNow running={data.running} serverTime={data.server_time} />
        </CardContent>
      </Card>

      {/* Today */}
      <div className="mb-5 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <div className="flex items-center justify-between rounded-2xl p-5 hero-green-card shadow-[0_8px_24px_rgba(20,83,56,0.18)]">
          <div>
            <p className="text-xs font-medium text-white/85">
              {data.is_self ? "My Day" : `${displayName(person).split(" ")[0]}'s Day`}
            </p>
            <p className="mt-1 tabular text-3xl font-bold text-white">
              {counts.due_today + counts.overdue}
            </p>
            <p className="mt-1 text-xs text-[#a9dfc2]">
              {counts.overdue} overdue · {counts.due_today} due today
              {(counts.older_overdue ?? 0) > 0 ? ` · ${counts.older_overdue} older` : ""}
            </p>
          </div>
          <span className="flex h-10 w-10 items-center justify-center rounded-2xl bg-white/15 text-white">
            <CalendarCheck className="h-5 w-5" aria-hidden />
          </span>
        </div>

        <Card className="flex items-center justify-between p-5">
          <div>
            <p className="text-xs font-medium text-muted-foreground">Completed Today</p>
            <p className="mt-1 tabular text-3xl font-bold text-foreground">
              {counts.completed_today}
            </p>
            <p className="mt-1 text-xs text-[#1f7a52]">{counts.completed_total} all time</p>
          </div>
          <span className="flex h-10 w-10 items-center justify-center rounded-2xl bg-[#eaf4ef] text-[#145338]">
            <CheckCircle2 className="h-5 w-5" aria-hidden />
          </span>
        </Card>

        <Card className="flex items-center justify-between p-5">
          <div>
            <p className="text-xs font-medium text-muted-foreground">Open Work</p>
            <p className="mt-1 tabular text-3xl font-bold text-foreground">{counts.open}</p>
            <p className="mt-1 text-xs text-[#1f7a52]">
              {counts.in_progress} in progress · {counts.blocked} blocked
            </p>
          </div>
          <span className="flex h-10 w-10 items-center justify-center rounded-2xl bg-[#eaf4ef] text-[#145338]">
            <FolderKanban className="h-5 w-5" aria-hidden />
          </span>
        </Card>

        <Card className="flex items-center justify-between p-5">
          <div>
            <p className="text-xs font-medium text-muted-foreground">Tracked Today</p>
            <p className="mt-1 tabular text-3xl font-bold text-foreground">
              {formatHours(data.daily.find((d) => d.day === today)?.seconds ?? 0)}
            </p>
            <p className="mt-1 text-xs text-[#1f7a52]">
              {formatHours(counts.tracked_seconds)} in {days} days ·{" "}
              {formatHours(counts.tracked_seconds_total)} total
            </p>
          </div>
          <span className="flex h-10 w-10 items-center justify-center rounded-2xl bg-[#eaf4ef] text-[#145338]">
            <Clock className="h-5 w-5" aria-hidden />
          </span>
        </Card>
      </div>

      <div className="grid gap-5 lg:grid-cols-[1.4fr_1fr]">
        {/* Day-by-day activity */}
        <Card>
          <CardHeader>
            <CardTitle>Day-by-day activity</CardTitle>
            <p className="text-xs text-muted-foreground">
              Every calendar day in the window, including the ones with nothing logged.
            </p>
          </CardHeader>
          <CardContent>
            <DayStrip daily={data.daily} />
          </CardContent>
        </Card>

        {/* Recent trail */}
        <Card>
          <CardHeader>
            <CardTitle>Recent activity</CardTitle>
            <p className="text-xs text-muted-foreground">
              Everything {data.is_self ? "you have" : `${displayName(person)} has`} recorded.
            </p>
          </CardHeader>
          <CardContent>
            {data.recent_activity.length === 0 ? (
              <p className="py-6 text-center text-sm text-muted-foreground">
                Nothing recorded yet.
              </p>
            ) : (
              <ul className="flex max-h-[22rem] flex-col gap-2 overflow-y-auto pr-1">
                {data.recent_activity.map((event) => (
                  <li
                    key={event.id}
                    className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 rounded-xl bg-muted/50 px-3 py-2 text-xs"
                  >
                    <span className="font-semibold text-foreground">
                      {EVENT_LABELS[event.event_type] ?? event.event_type}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-muted-foreground">
                      {event.summary.charAt(0).toUpperCase() + event.summary.slice(1)}
                    </span>
                    <span className="shrink-0 tabular text-muted-foreground">
                      {formatReadable(event.created_at)}
                    </span>
                    {event.task_id ? (
                      <Link
                        href={`/tasks/${event.task_id}`}
                        className="shrink-0 font-medium text-[#145338] hover:underline"
                      >
                        Open
                      </Link>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Today's work, in priority order */}
      <div className="mt-5 grid gap-5 md:grid-cols-2">
        <TaskSection title="Overdue" rows={data.tasks.overdue} today={today} tone="danger" />
        <TaskSection title="Due Today" rows={data.tasks.due_today} today={today} />
        <TaskSection title="In Progress" rows={data.tasks.in_progress} today={today} />
        <TaskSection title="Completed Today" rows={data.tasks.completed_today} today={today} tone="success" />
      </div>

      <Card className="mt-5">
        <CardContent className="flex flex-wrap items-center gap-3 p-4 text-sm">
          <History className="h-4 w-4 text-muted-foreground" aria-hidden />
          <span className="text-muted-foreground">Want the raw breakdown?</span>
          <Link href={`/time${data.is_self ? "" : `?user_id=${person.id}`}`}>
            <Button variant="outline" size="sm">
              Open tracked time
            </Button>
          </Link>
        </CardContent>
      </Card>
    </>
  );
}

function RunningNow({
  running,
  serverTime,
}: {
  running: UserProfile["running"];
  serverTime: string;
}) {
  const first = running[0];
  const elapsed = useElapsed(first?.started_at, serverTime);
  if (!first) return null;
  return (
    <div className="rounded-2xl bg-[#eaf4ef] px-4 py-3 text-right">
      <p className="flex items-center justify-end gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-[#145338]">
        <Timer className="h-3.5 w-3.5" aria-hidden />
        Working now
      </p>
      <p className="mt-0.5 max-w-[16rem] truncate text-sm font-semibold text-foreground">
        {first.task_title}
      </p>
      <p className="tabular text-lg font-bold text-[#145338]">
        {formatDuration(elapsed)}
        {first.is_stale ? " (stale)" : ""}
      </p>
    </div>
  );
}

/**
 * One bar per day. Days with no hours are drawn as a flat striped stub rather
 * than omitted -- a gap in the strip reads as "we lost the data", which is a
 * different and wrong claim from "nothing was logged that day".
 */
function DayStrip({ daily }: { daily: UserProfile["daily"] }) {
  if (daily.length === 0) {
    return <p className="py-8 text-center text-sm text-muted-foreground">No activity in range.</p>;
  }
  const maxSeconds = Math.max(1, ...daily.map((d) => d.seconds));
  const maxCompleted = Math.max(1, ...daily.map((d) => d.completed));

  return (
    <div>
      <div
        className="flex items-end gap-1 overflow-x-auto pb-2"
        role="img"
        aria-label="Daily tracked hours and completed tasks"
      >
        {daily.map((d) => {
          const hours = d.seconds / 3600;
          const heightPct = d.seconds > 0 ? Math.max(8, Math.round((d.seconds / maxSeconds) * 100)) : 2;
          return (
            <div
              key={d.day}
              className="group flex min-w-[2rem] flex-1 flex-col items-center gap-1"
              title={`${formatDayLabel(d.day)}: ${formatDuration(d.seconds)} tracked, ${d.completed} completed`}
            >
              <div className="relative flex h-32 w-full items-end justify-center">
                <div
                  className={cn(
                    "w-full max-w-[26px] rounded-t-md transition-all",
                    hours > 0 ? "bg-[#1f7a52]" : "striped-bar",
                  )}
                  style={{ height: `${heightPct}%` }}
                />
              </div>
              {d.completed > 0 ? (
                <span
                  className="tabular rounded bg-[#145338] px-1 text-[9px] font-semibold text-white"
                  style={{ minWidth: `${Math.max(20, (d.completed / maxCompleted) * 100)}%` }}
                >
                  {d.completed}
                </span>
              ) : (
                <span className="h-[14px]" />
              )}
              <span className="text-[10px] font-medium text-muted-foreground">
                {formatDayLabel(d.day).split(",")[0]}
              </span>
            </div>
          );
        })}
      </div>
      <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-border/60 pt-3 text-xs text-muted-foreground">
        <span>
          {formatHours(daily.reduce((acc, d) => acc + d.seconds, 0))} tracked ·{" "}
          {daily.reduce((acc, d) => acc + d.completed, 0)} tasks completed
        </span>
        <span>
          {daily.filter((d) => d.seconds > 0).length} of {daily.length} days with time logged
        </span>
      </div>
    </div>
  );
}

function TaskSection({
  title,
  rows,
  today,
  tone = "default",
}: {
  title: string;
  rows: WorklistRow[];
  today: string;
  tone?: "default" | "danger" | "success";
}) {
  if (rows.length === 0) return null;
  const border =
    tone === "danger"
      ? "border-destructive/40"
      : tone === "success"
        ? "border-success/30"
        : "";
  return (
    <Card className={border}>
      <CardHeader>
        <CardTitle>
          {title} <span className="text-sm font-normal text-muted-foreground">({rows.length})</span>
        </CardTitle>
      </CardHeader>
      <CardContent>
        <ul className="flex flex-col gap-2.5">
          {rows.map((row) => (
            <li key={row.id} className="flex flex-wrap items-center gap-2 text-sm">
              <StatusBadge status={row.status} />
              <Link
                href={`/tasks/${row.id}`}
                className="min-w-0 flex-1 font-medium hover:underline"
              >
                {row.title}
              </Link>
              {row.due_date ? (
                <Badge variant={row.is_overdue ? "danger" : "outline"}>
                  {row.is_overdue ? `overdue ${row.due_date}` : `due ${row.due_date}`}
                </Badge>
              ) : null}
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}