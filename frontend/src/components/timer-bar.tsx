"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Pause, Play, TriangleAlert } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { formatClock, parseUtc } from "@/lib/format";
import type { RunningTimer } from "@/lib/types";

interface TimerResponse {
  running: RunningTimer | null;
  server_time: string;
}

export function useRunningTimer() {
  return useQuery({
    queryKey: ["timer"],
    queryFn: () => api<TimerResponse>("/timer/current"),
    refetchInterval: 30_000,
    staleTime: 5_000,
  });
}

export function useInvalidate() {
  const client = useQueryClient();
  return useCallback(() => client.invalidateQueries(), [client]);
}

/** Elapsed time is measured from started_at against the server clock (D-15). */
export function useElapsed(startedAt: string | undefined, serverTime: string | undefined) {
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    if (!startedAt) return;
    const sync = () => {
      const now = serverTime ? parseUtc(serverTime).getTime() : Date.now();
      setElapsed(Math.max(0, Math.floor((now - parseUtc(startedAt).getTime()) / 1000)));
    };
    sync();
    const timer = window.setInterval(sync, 1000);
    return () => window.clearInterval(timer);
  }, [startedAt, serverTime]);

  return elapsed;
}

export function TimerBar() {
  const { data } = useRunningTimer();
  const invalidate = useInvalidate();
  const [pausing, setPausing] = useState(false);

  const running = data?.running ?? null;
  const elapsed = useElapsed(running?.started_at, data?.server_time);

  if (!running) return null;

  const pause = async () => {
    setPausing(true);
    try {
      await api("/timer/pause", { method: "POST", json: {} });
      await invalidate();
    } finally {
      setPausing(false);
    }
  };

  return (
    <div className="sticky bottom-0 z-30 border-t border-border bg-card/95 backdrop-blur">
      <div className="mx-auto flex max-w-7xl flex-wrap items-center gap-3 px-4 py-2.5">
        <span className="relative flex h-2.5 w-2.5">
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-success opacity-75" />
          <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-success" />
        </span>
        <span className="tabular text-sm font-semibold">{formatClock(elapsed)}</span>
        <Link
          href={`/tasks/${running.task_id}`}
          className="min-w-0 flex-1 truncate text-sm text-muted-foreground hover:text-foreground"
        >
          {running.task_title}
        </Link>
        {running.is_stale ? (
          <span className="inline-flex items-center gap-1 text-xs text-warning">
            <TriangleAlert className="h-3.5 w-3.5" aria-hidden />
            Stale — enter the real end time
          </span>
        ) : null}
        <Button size="sm" variant="outline" onClick={pause} loading={pausing}>
          <Pause className="h-4 w-4" aria-hidden />
          Pause
        </Button>
        <Link href={`/tasks/${running.task_id}`}>
          <Button size="sm" variant="ghost">
            <Play className="h-4 w-4" aria-hidden />
            Open
          </Button>
        </Link>
      </div>
    </div>
  );
}

export function useSessionTimezone() {
  return useAuth().appTimezone;
}