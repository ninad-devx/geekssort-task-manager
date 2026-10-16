"use client";

import { useQuery } from "@tanstack/react-query";
import { Activity, ArrowUpRight, Calendar, Filter, User } from "lucide-react";
import Link from "next/link";
import { useState } from "react";

import { PageHeader } from "@/components/app-shell";
import { Button } from "@/components/ui/button";
import { Card, EmptyState, ErrorState, Spinner } from "@/components/ui/card";
import { Badge, Input, Select } from "@/components/ui/form";
import { api, ApiError, qs } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { formatDateTime } from "@/lib/format";
import { EVENT_LABELS, type AuditEvent, type AuditList, type DirectoryEntry } from "@/lib/types";

export default function ActivityPage() {
  const { capabilities } = useAuth();
  const [eventType, setEventType] = useState("");
  const [userId, setUserId] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [page, setPage] = useState(1);
  const [expanded, setExpanded] = useState<number | null>(null);

  const canFilterByUser = !!capabilities?.can_view_team;
  const activeFilters = [eventType, userId, from, to].filter(Boolean).length;

  const events = useQuery({
    queryKey: ["audit", "feed", eventType, userId, from, to, page],
    queryFn: () =>
      api<AuditList>(
        `/audit${qs({ event_type: eventType, user_id: userId, date_from: from, date_to: to, page, page_size: 50 })}`,
      ),
  });

  const directory = useQuery({
    queryKey: ["directory"],
    queryFn: () => api<DirectoryEntry[]>("/users/directory"),
    enabled: canFilterByUser,
  });

  if (!events.data && !events.isLoading && !events.isError) return <Spinner label="Loading activity" />;

  const totalEvents = events.data?.total ?? 0;

  return (
    <>
      <PageHeader
        title="Task Activity"
        description="Every recorded change, newest first. Append-only audit log — nothing here can be edited or removed."
      />

      {/* Summary KPI Strip */}
      <div className="mb-5 grid gap-4 sm:grid-cols-3">
        <div className="flex items-center justify-between rounded-2xl p-5 hero-green-card shadow-[0_8px_24px_rgba(20,83,56,0.18)]">
          <div>
            <p className="text-xs font-medium text-white/85">Recorded Audit Events</p>
            <p className="mt-1 tabular text-3xl font-bold text-white">{totalEvents}</p>
            <p className="mt-1 text-xs text-[#a9dfc2]">Immutable history entries</p>
          </div>
          <span className="flex h-10 w-10 items-center justify-center rounded-2xl bg-white/15 text-white">
            <Activity className="h-5 w-5" aria-hidden />
          </span>
        </div>

        <Card className="flex items-center justify-between p-5">
          <div>
            <p className="text-xs font-medium text-muted-foreground">Active Filters</p>
            <p className="mt-1 tabular text-3xl font-bold text-foreground">{activeFilters}</p>
            <p className="mt-1 text-xs text-[#1f7a52]">
              {activeFilters > 0 ? "Filtered audit stream" : "Showing all event types"}
            </p>
          </div>
          <span className="flex h-10 w-10 items-center justify-center rounded-2xl bg-[#eaf4ef] text-[#145338]">
            <Filter className="h-5 w-5" aria-hidden />
          </span>
        </Card>

        <Card className="flex items-center justify-between p-5">
          <div>
            <p className="text-xs font-medium text-muted-foreground">Current Page</p>
            <p className="mt-1 tabular text-3xl font-bold text-foreground">{page}</p>
            <p className="mt-1 text-xs text-muted-foreground">Up to 50 events per page</p>
          </div>
          <span className="flex h-10 w-10 items-center justify-center rounded-2xl bg-[#eaf4ef] text-[#145338]">
            <Calendar className="h-5 w-5" aria-hidden />
          </span>
        </Card>
      </div>

      {/* Filter Bar Card */}
      <Card className="mb-5 p-3.5">
        <div className="flex flex-wrap items-center gap-2.5">
          <Input
            className="h-9 w-auto rounded-full px-3.5"
            type="date"
            aria-label="From date"
            value={from}
            onChange={(e) => {
              setFrom(e.target.value);
              setPage(1);
            }}
          />
          <Input
            className="h-9 w-auto rounded-full px-3.5"
            type="date"
            aria-label="To date"
            value={to}
            onChange={(e) => {
              setTo(e.target.value);
              setPage(1);
            }}
          />
          <Select
            className="h-9 w-auto rounded-full px-4"
            value={eventType}
            onChange={(e) => {
              setEventType(e.target.value);
              setPage(1);
            }}
          >
            <option value="">All event types</option>
            {Object.entries(EVENT_LABELS).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </Select>
          {canFilterByUser ? (
            <Select
              className="h-9 w-auto rounded-full px-4"
              value={userId}
              onChange={(e) => {
                setUserId(e.target.value);
                setPage(1);
              }}
            >
              <option value="">Everyone</option>
              {(directory.data ?? []).map((entry) => (
                <option key={entry.id} value={entry.id}>
                  {entry.full_name}
                </option>
              ))}
            </Select>
          ) : null}
          {activeFilters > 0 ? (
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                setEventType("");
                setUserId("");
                setFrom("");
                setTo("");
                setPage(1);
                setExpanded(null);
              }}
            >
              Clear {activeFilters} filter{activeFilters === 1 ? "" : "s"}
            </Button>
          ) : null}
        </div>
      </Card>

      {events.isLoading ? (
        <Spinner label="Loading activity" />
      ) : events.isError ? (
        <ErrorState
          message={events.error instanceof ApiError ? events.error.message : "Could not load activity."}
          onRetry={() => void events.refetch()}
        />
      ) : events.data!.items.length === 0 ? (
        <EmptyState title="Nothing recorded yet" description="Activity appears as soon as work starts." />
      ) : (
        <>
          <ul className="divide-y divide-border/70 overflow-hidden rounded-2xl border border-border/80 bg-card shadow-[0_2px_10px_rgba(0,0,0,0.02)]">
            {events.data!.items.map((event) => (
              <li
                key={event.id}
                className="bg-card px-5 py-4 transition-colors hover:bg-muted/30"
              >
                <div className="flex flex-wrap items-center gap-2.5">
                  <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-[#eaf4ef] text-[#145338]">
                    <User className="h-3.5 w-3.5" aria-hidden />
                  </span>
                  <span className="text-sm font-bold text-foreground">{event.actor_name}</span>
                  <Badge variant="default">
                    {EVENT_LABELS[event.event_type] ?? event.event_type}
                  </Badge>
                  <span className="min-w-0 flex-1 text-sm text-muted-foreground">
                    {plainSummary(event.summary)}
                  </span>
                  <span className="text-xs font-medium text-muted-foreground tabular">
                    {formatDateTime(event.created_at)}
                  </span>
                  {event.task_id ? (
                    <Link
                      href={`/tasks/${event.task_id}`}
                      className="inline-flex items-center gap-1 rounded-full border border-[#145338]/25 bg-[#eaf4ef]/60 px-2.5 py-0.5 text-xs font-semibold text-[#145338] hover:bg-[#145338] hover:text-white"
                    >
                      Open task
                      <ArrowUpRight className="h-3 w-3" aria-hidden />
                    </Link>
                  ) : null}
                  {hasDiff(event) ? (
                    <button
                      type="button"
                      className="rounded-full border border-border px-2.5 py-0.5 text-xs font-medium text-muted-foreground hover:border-foreground/30 hover:text-foreground"
                      onClick={() => setExpanded(expanded === event.id ? null : event.id)}
                    >
                      {expanded === event.id ? "Hide detail" : "Detail"}
                    </button>
                  ) : null}
                </div>
                {expanded === event.id ? <Diff before={event.before} after={event.after} /> : null}
              </li>
            ))}
          </ul>

          <div className="mt-4 flex items-center justify-between text-sm">
            <span className="text-muted-foreground">{events.data!.total} events</span>
            <div className="flex gap-2">
              <Button
                variant="outline"
                size="sm"
                disabled={page <= 1}
                onClick={() => setPage(page - 1)}
              >
                Previous
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={page * 50 >= events.data!.total}
                onClick={() => setPage(page + 1)}
              >
                Next
              </Button>
            </div>
          </div>
        </>
      )}
    </>
  );
}

function hasDiff(event: AuditEvent): boolean {
  return !!(event.before || event.after);
}

function plainSummary(summary: string): string {
  return summary.charAt(0).toUpperCase() + summary.slice(1);
}

function renderValue(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (Array.isArray(value)) return value.length ? value.join(", ") : "none";
  if (typeof value === "object") return JSON.stringify(value);
  if (typeof value === "boolean") return value ? "yes" : "no";
  return String(value);
}

function Diff({
  before,
  after,
}: {
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
}) {
  const keys = Array.from(new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})]))
    .filter((key) => key !== "permissions")
    .slice(0, 12);
  if (keys.length === 0) return null;

  return (
    <dl className="mt-3 grid gap-1.5 rounded-xl border border-border/60 bg-muted/40 p-3 text-xs">
      {keys.map((key) => (
        <div key={key} className="flex flex-wrap gap-x-2">
          <dt className="font-medium text-muted-foreground">{key.replace(/_/g, " ")}:</dt>
          <dd className="text-muted-foreground line-through">{renderValue(before?.[key])}</dd>
          <dd className="font-semibold text-[#145338]">{renderValue(after?.[key])}</dd>
        </div>
      ))}
    </dl>
  );
}