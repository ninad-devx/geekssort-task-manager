"use client";

import { useQuery } from "@tanstack/react-query";
import { ChevronDown, ChevronRight, Clock, Layers, Users } from "lucide-react";
import Link from "next/link";
import { useState } from "react";

import { PageHeader, roleLabel } from "@/components/app-shell";
import { Avatar, displayName } from "@/components/avatar";
import { Card, CardContent, EmptyState, ErrorState, Spinner } from "@/components/ui/card";
import { Badge, Progress, Select } from "@/components/ui/form";
import { api, ApiError, qs } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { formatDayLabel, formatDuration, formatHours } from "@/lib/format";
import { STATUS_LABELS, type DirectoryEntry, type Role, type TaskStatus } from "@/lib/types";

interface TimeTaskTotal {
  task_id: number;
  task_title: string;
  task_status: TaskStatus;
  seconds: number;
  entry_count: number;
}

interface TimePersonTotal {
  user: { id: number; full_name: string; role: Role };
  seconds: number;
  entry_count: number;
  tasks: TimeTaskTotal[];
}

interface TimeSummary {
  scope: "self" | "company";
  days: number;
  range?: { from: string; to: string } | null;
  total_seconds: number;
  people: TimePersonTotal[];
}

/**
 * Today first.
 *
 * `days=1` is today alone -- the server counts today as one of the days, where
 * the old arithmetic subtracted a full day and then truncated to UTC midnight,
 * so even the shortest window was really "yesterday evening plus today".
 */
const RANGES = [
  { value: 1, label: "Today" },
  { value: 7, label: "Last 7 days" },
  { value: 30, label: "Last 30 days" },
  { value: 90, label: "Last 90 days" },
];

export default function TimePage() {
  const { capabilities } = useAuth();
  const [days, setDays] = useState(1);
  const [person, setPerson] = useState("");
  const [open, setOpen] = useState<Set<number>>(new Set());

  const directory = useQuery({
    queryKey: ["directory"],
    queryFn: () => api<DirectoryEntry[]>("/users/directory"),
    enabled: !!capabilities?.can_view_team,
  });

  const summary = useQuery({
    queryKey: ["time", "summary", days, person],
    queryFn: () => api<TimeSummary>(`/time/summary${qs({ days, user_id: person })}`),
  });

  const toggle = (id: number) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  if (summary.isLoading) return <Spinner label="Loading tracked time" />;
  if (summary.isError || !summary.data) {
    return (
      <ErrorState
        message={
          summary.error instanceof ApiError ? summary.error.message : "Could not load tracked time."
        }
        onRetry={() => void summary.refetch()}
      />
    );
  }

  const data = summary.data;
  // Once a single person is picked, the scope is no longer the company even for
  // a lead -- the header must not keep claiming a company total it is not showing.
  const isCompany = data.scope === "company" && !person;
  const singlePerson = person ? (directory.data ?? []).find((d) => String(d.id) === person) : null;
  const totalSessions = data.people.reduce((acc, p) => acc + p.entry_count, 0);
  const rangeLabel = RANGES.find((r) => r.value === days)?.label ?? `Last ${days} days`;

  const scopeLabel = singlePerson
    ? displayName(singlePerson)
    : isCompany
      ? "Company"
      : "Your";

  return (
    <>
      <PageHeader
        title="Tracked Time"
        description={
          isCompany
            ? "Totals per person, then per task. Open a person to see where their hours went."
            : "Your tracked time, task by task."
        }
        actions={
          <>
            {capabilities?.can_view_team ? (
              <Select
                value={person}
                onChange={(e) => setPerson(e.target.value)}
                aria-label="Filter by person"
                className="h-10 w-auto min-w-[9rem] rounded-full px-4"
              >
                <option value="">Everyone</option>
                {(directory.data ?? []).map((entry) => (
                  <option key={entry.id} value={entry.id}>
                    {displayName(entry)}
                  </option>
                ))}
              </Select>
            ) : null}
            <select
              value={days}
              onChange={(e) => setDays(Number(e.target.value))}
              aria-label="Tracked time range"
              className="h-10 rounded-full border border-[#145338]/30 bg-card px-4 text-sm font-medium text-foreground shadow-2xs transition-colors hover:border-[#145338] focus:outline-none focus:ring-2 focus:ring-ring"
            >
              {RANGES.map((range) => (
                <option key={range.value} value={range.value}>
                  {range.label}
                </option>
              ))}
            </select>
          </>
        }
      />

      {/* Summary KPI Strip */}
      <div className="mb-5 grid gap-4 sm:grid-cols-3">
        <div className="flex items-center justify-between rounded-2xl p-5 hero-green-card shadow-[0_8px_24px_rgba(20,83,56,0.20)]">
          <div>
            <p className="text-xs font-semibold uppercase tracking-wider text-white/80">
              {scopeLabel} Total
            </p>
            <p className="mt-1 tabular text-4xl font-bold text-white">
              {formatHours(data.total_seconds)}
            </p>
            <p className="mt-1 text-xs text-[#a9dfc2]">{rangeLabel.toLowerCase()}</p>
          </div>
          <span className="flex h-11 w-11 items-center justify-center rounded-2xl bg-white/15 text-white">
            <Clock className="h-5 w-5" aria-hidden />
          </span>
        </div>

        <Card className="flex items-center justify-between p-5">
          <div>
            <p className="text-xs font-medium text-muted-foreground">
              {isCompany ? "Contributors Logged" : "Tasks Worked On"}
            </p>
            <p className="mt-1 tabular text-3xl font-bold text-foreground">
              {isCompany ? data.people.length : (data.people[0]?.tasks.length ?? 0)}
            </p>
            <p className="mt-1 text-xs text-[#1f7a52]">With recorded time in range</p>
          </div>
          <span className="flex h-11 w-11 items-center justify-center rounded-2xl bg-[#eaf4ef] text-[#145338]">
            <Users className="h-5 w-5" aria-hidden />
          </span>
        </Card>

        <Card className="flex items-center justify-between p-5">
          <div>
            <p className="text-xs font-medium text-muted-foreground">Work Sessions</p>
            <p className="mt-1 tabular text-3xl font-bold text-foreground">{totalSessions}</p>
            <p className="mt-1 text-xs text-muted-foreground">Timer and manual segments</p>
          </div>
          <span className="flex h-11 w-11 items-center justify-center rounded-2xl bg-[#eaf4ef] text-[#145338]">
            <Layers className="h-5 w-5" aria-hidden />
          </span>
        </Card>
      </div>

      {data.people.length === 0 ? (
        <EmptyState
          title="No tracked time in this range"
          description={
            isCompany
              ? "Once somebody runs a timer, their hours appear here."
              : "Start a timer from any task assigned to you and your hours will build up here."
          }
        />
      ) : (
        <div className="space-y-3">
          {data.people.map((person) => {
            const expanded = open.has(person.user.id);
            const share =
              data.total_seconds > 0 ? Math.round((person.seconds / data.total_seconds) * 100) : 0;

            return (
              <Card
                key={person.user.id}
                className="overflow-hidden transition-all hover:border-[#145338]/30"
              >
                <CardContent className="p-0">
                  <button
                    type="button"
                    className="flex w-full flex-wrap items-center gap-3.5 px-5 py-4 text-left transition-colors hover:bg-muted/30"
                    onClick={() => toggle(person.user.id)}
                    aria-expanded={expanded}
                  >
                    <Avatar person={person.user} size="md" />
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-bold text-foreground">{person.user.full_name}</span>
                        <span className="text-xs text-muted-foreground">
                          {roleLabel(person.user.role)}
                        </span>
                        <Badge variant="default">
                          {person.tasks.length} task{person.tasks.length === 1 ? "" : "s"}
                        </Badge>
                        <Badge variant="muted">
                          {person.entry_count} session{person.entry_count === 1 ? "" : "s"}
                        </Badge>
                      </div>
                      {isCompany ? (
                        <div className="mt-2 max-w-xs">
                          <Progress value={share} label={`${person.user.full_name} share`} />
                        </div>
                      ) : null}
                    </div>

                    <div className="ml-auto flex items-center gap-3">
                      <div className="text-right">
                        <span className="block tabular text-lg font-bold text-foreground">
                          {formatDuration(person.seconds)}
                        </span>
                        {isCompany ? (
                          <span className="block tabular text-xs text-muted-foreground">
                            {share}% of company time
                          </span>
                        ) : null}
                      </div>
                      <span className="flex h-7 w-7 items-center justify-center rounded-full bg-muted/80 text-muted-foreground">
                        {expanded ? (
                          <ChevronDown className="h-4 w-4 shrink-0" aria-hidden />
                        ) : (
                          <ChevronRight className="h-4 w-4 shrink-0" aria-hidden />
                        )}
                      </span>
                    </div>
                  </button>

                  {expanded ? (
                    <>
                      <div className="border-t border-border/70 bg-muted/15 px-5 py-2.5 text-xs text-muted-foreground">
                        <Link
                          href={`/users/${person.user.id}`}
                          className="inline-flex items-center gap-1.5 rounded-full border border-[#145338]/25 bg-[#eaf4ef]/60 px-2.5 py-1 font-semibold text-[#145338] hover:bg-[#145338] hover:text-white"
                        >
                          <Avatar person={person.user} size="xs" />
                          View {displayName(person.user)}&rsquo;s profile and daily activity
                        </Link>
                      </div>
                      <ul className="divide-y divide-border/60 border-t border-border/70 bg-muted/15 px-5 py-2">
                        {person.tasks.map((task) => (
                          <li
                            key={task.task_id}
                            className="flex flex-wrap items-center gap-3 py-2.5 text-sm"
                          >
                            <Badge variant="outline">{STATUS_LABELS[task.task_status]}</Badge>
                            <Link
                              href={`/tasks/${task.task_id}`}
                              className="min-w-0 flex-1 truncate font-semibold text-foreground hover:text-[#145338] hover:underline"
                            >
                              {task.task_title}
                            </Link>
                            <span className="text-xs text-muted-foreground">
                              {task.entry_count} session{task.entry_count === 1 ? "" : "s"}
                            </span>
                            <span className="tabular font-bold text-foreground">
                              {formatDuration(task.seconds)}
                            </span>
                          </li>
                        ))}
                      </ul>
                    </>
                  ) : null}
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}

      <p className="mt-6 text-xs text-muted-foreground">
        Showing {rangeLabel.toLowerCase()}
        {data.range?.from ? ` (${formatDayLabel(String(data.range.from).slice(0, 10))})` : ""}.
        Open a person for their day-by-day history on their profile.
      </p>
    </>
  );
}