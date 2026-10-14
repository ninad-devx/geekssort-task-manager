"use client";

import { useQuery } from "@tanstack/react-query";
import { ChevronDown, ChevronRight } from "lucide-react";
import Link from "next/link";
import { useState } from "react";

import { PageHeader } from "@/components/app-shell";
import { Card, CardContent, EmptyState, ErrorState, Spinner } from "@/components/ui/card";
import { Badge } from "@/components/ui/form";
import { api, ApiError, qs } from "@/lib/api";
import { formatDuration, formatHours } from "@/lib/format";
import { STATUS_LABELS, type TaskStatus } from "@/lib/types";

interface TimeTaskTotal {
  task_id: number;
  task_title: string;
  task_status: TaskStatus;
  seconds: number;
  entry_count: number;
}

interface TimePersonTotal {
  user: { id: number; full_name: string; role: string };
  seconds: number;
  entry_count: number;
  tasks: TimeTaskTotal[];
}

interface TimeSummary {
  scope: "self" | "company";
  days: number;
  total_seconds: number;
  people: TimePersonTotal[];
}

export default function TimePage() {
  const [days, setDays] = useState(30);
  const [open, setOpen] = useState<Set<number>>(new Set());

  const summary = useQuery({
    queryKey: ["time", "summary", days],
    queryFn: () => api<TimeSummary>(`/time/summary${qs({ days })}`),
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
  const isCompany = data.scope === "company";

  return (
    <>
      <PageHeader
        title="Tracked time"
        description={
          isCompany
            ? "Totals per person, then per task. Open a person to see where their hours went."
            : "Your own tracked time, task by task."
        }
        actions={
          <select
            value={days}
            onChange={(e) => setDays(Number(e.target.value))}
            className="h-9 rounded-md border border-input bg-card px-3 text-sm"
          >
            <option value={7}>Last 7 days</option>
            <option value={30}>Last 30 days</option>
            <option value={90}>Last 90 days</option>
          </select>
        }
      />

      <Card className="mb-5">
        <CardContent className="flex flex-wrap items-baseline gap-3">
          <span className="text-xs font-medium text-muted-foreground">
            {isCompany ? "Company total" : "Your total"}
          </span>
          <span className="tabular text-3xl font-semibold">{formatHours(data.total_seconds)}</span>
          <span className="text-xs text-muted-foreground">over the last {data.days} days</span>
        </CardContent>
      </Card>

      {data.people.length === 0 ? (
        <EmptyState
          title="No tracked time yet"
          description={
            isCompany
              ? "Once somebody runs a timer, their hours appear here."
              : "Start a timer from any task assigned to you and your hours will build up here."
          }
        />
      ) : (
        <div className="space-y-2">
          {data.people.map((person) => {
            const expanded = open.has(person.user.id);
            const share =
              data.total_seconds > 0 ? Math.round((person.seconds / data.total_seconds) * 100) : 0;

            return (
              <Card key={person.user.id}>
                <CardContent className="py-3">
                  <button
                    type="button"
                    className="flex w-full flex-wrap items-center gap-3 text-left"
                    onClick={() => toggle(person.user.id)}
                    aria-expanded={expanded}
                  >
                    {expanded ? (
                      <ChevronDown className="h-4 w-4 shrink-0" aria-hidden />
                    ) : (
                      <ChevronRight className="h-4 w-4 shrink-0" aria-hidden />
                    )}
                    <span className="font-medium">{person.user.full_name}</span>
                    {isCompany ? (
                      <span className="text-xs text-muted-foreground">
                        {person.tasks.length} task{person.tasks.length === 1 ? "" : "s"}
                      </span>
                    ) : null}
                    <span className="ml-auto flex items-baseline gap-3">
                      <span className="tabular text-lg font-semibold">
                        {formatDuration(person.seconds)}
                      </span>
                      {isCompany ? (
                        <span className="tabular text-xs text-muted-foreground">{share}%</span>
                      ) : null}
                    </span>
                  </button>

                  {expanded ? (
                    <ul className="mt-3 space-y-1 border-l-2 border-border pl-4">
                      {person.tasks.map((task) => (
                        <li key={task.task_id} className="flex flex-wrap items-center gap-3 text-sm">
                          <Badge variant="outline">{STATUS_LABELS[task.task_status]}</Badge>
                          <Link
                            href={`/tasks/${task.task_id}`}
                            className="min-w-0 flex-1 truncate hover:underline"
                          >
                            {task.task_title}
                          </Link>
                          <span className="text-xs text-muted-foreground">
                            {task.entry_count} session{task.entry_count === 1 ? "" : "s"}
                          </span>
                          <span className="tabular font-medium">{formatDuration(task.seconds)}</span>
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}
    </>
  );
}