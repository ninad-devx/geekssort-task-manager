"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useState } from "react";

import { PageHeader } from "@/components/app-shell";
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
        <ButtonReset
          onClick={() => {
            setEventType("");
            setUserId("");
            setFrom("");
            setTo("");
            setPage(1);
          }}
        />
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
          <Card>
            <ul>
              {events.data!.items.map((event) => (
                <li key={event.id} className="border-b border-border px-4 py-3 last:border-b-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge variant="outline">{EVENT_LABELS[event.event_type] ?? event.event_type}</Badge>
                    <span className="text-sm">{event.actor_name}</span>
                    <span className="text-xs text-muted-foreground">{formatDateTime(event.created_at)}</span>
                    {event.task_id ? (
                      <Link href={`/tasks/${event.task_id}`} className="text-xs text-primary hover:underline">
                        Open task
                      </Link>
                    ) : null}
                    {hasDiff(event) ? (
                      <button
                        type="button"
                        className="ml-auto text-xs text-muted-foreground hover:text-foreground"
                        onClick={() => setExpanded(expanded === event.id ? null : event.id)}
                      >
                        {expanded === event.id ? "Hide changes" : "Show changes"}
                      </button>
                    ) : null}
                  </div>
                  <p className="mt-1 text-sm">{event.summary}</p>
                  {expanded === event.id ? <Diff before={event.before} after={event.after} /> : null}
                </li>
              ))}
            </ul>
          </Card>
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

function ButtonReset({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="rounded-md px-3 py-1.5 text-xs text-muted-foreground hover:text-foreground"
    >
      Clear
    </button>
  );
}

function hasDiff(event: AuditEvent): boolean {
  return !!(event.before || event.after);
}

function Diff({
  before,
  after,
}: {
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
}) {
  const keys = Array.from(new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})]));
  return (
    <table className="mt-2 w-full text-xs">
      <tbody>
        {keys.map((key) => (
          <tr key={key} className="align-top">
            <td className="w-32 py-0.5 pr-2 text-muted-foreground">{key}</td>
            <td className="w-1/3 py-0.5 pr-2 text-muted-foreground line-through">
              {show(before?.[key])}
            </td>
            <td className="py-0.5">{show(after?.[key])}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function show(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}