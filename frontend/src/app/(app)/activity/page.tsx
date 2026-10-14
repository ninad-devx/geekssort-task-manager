"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useState } from "react";

import { PageHeader } from "@/components/app-shell";
import { Button } from "@/components/ui/button";
import { EmptyState, ErrorState, Spinner } from "@/components/ui/card";
import { Input, Select } from "@/components/ui/form";
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

  return (
    <>
      <PageHeader
        title="Task Activity"
        description="Every recorded change, newest first. Nothing here can be edited or removed."
      />

      <div className="mb-4 flex flex-wrap gap-2">
        <Input
          className="h-9 w-auto"
          type="date"
          value={from}
          onChange={(e) => {
            setFrom(e.target.value);
            setPage(1);
          }}
        />
        <Input
          className="h-9 w-auto"
          type="date"
          value={to}
          onChange={(e) => {
            setTo(e.target.value);
            setPage(1);
          }}
        />
        <Select
          className="h-9 w-auto"
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
            className="h-9 w-auto"
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
          <ul className="divide-y divide-border overflow-hidden rounded-lg border border-border">
            {events.data!.items.map((event) => (
              <li key={event.id} className="bg-card px-4 py-3">
                <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                  <span className="text-xs font-medium text-muted-foreground">
                    {formatDateTime(event.created_at)}
                  </span>
                  <span className="text-sm font-medium">{event.actor_name}</span>
                  <span className="text-sm text-muted-foreground">
                    {plainSummary(event.summary)}
                  </span>
                  {event.task_id ? (
                    <Link
                      href={`/tasks/${event.task_id}`}
                      className="text-xs text-primary hover:underline"
                    >
                      Open task
                    </Link>
                  ) : null}
                  {hasDiff(event) ? (
                    <button
                      type="button"
                      className="ml-auto text-xs text-muted-foreground hover:text-foreground"
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
              <button
                type="button"
                className="rounded-md border border-input px-3 py-1.5 text-xs disabled:opacity-50"
                disabled={page <= 1}
                onClick={() => setPage(page - 1)}
              >
                Previous
              </button>
              <button
                type="button"
                className="rounded-md border border-input px-3 py-1.5 text-xs disabled:opacity-50"
                disabled={page * 50 >= events.data!.total}
                onClick={() => setPage(page + 1)}
              >
                Next
              </button>
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

/**
 * Summaries already read as sentences ("Sam moved 'Q3 deck' to In Review").
 * The raw event-type badge was duplicating that and crowding the row, so it is
 * gone and the sentence leads instead.
 */
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
    <dl className="mt-2 grid gap-1 border-l-2 border-border pl-3 text-xs">
      {keys.map((key) => (
        <div key={key} className="flex flex-wrap gap-x-2">
          <dt className="text-muted-foreground">{key.replace(/_/g, " ")}</dt>
          <dd className="text-muted-foreground line-through">{renderValue(before?.[key])}</dd>
          <dd className="font-medium">{renderValue(after?.[key])}</dd>
        </div>
      ))}
    </dl>
  );
}