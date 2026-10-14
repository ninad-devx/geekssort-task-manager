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
  running: RunningTimer[];
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

/**
 * Elapsed time is measured from started_at against the server clock (D-15).
 *
 * The server's clock is sampled once and stored as an offset from the browser
 * clock, then advanced locally. Re-anchoring on every 30s poll was what made
 * the display stutter: each new sample shifted the baseline and the counter
 * visibly jumped. The offset is only recomputed when started_at changes.
 */
export function useElapsed(startedAt: string | undefined, serverTime: string | undefined) {
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    if (!startedAt) {
      setElapsed(0);
      return;
    }

    const startedMs = parseUtc(startedAt).getTime();
    const offsetMs = serverTime ? parseUtc(serverTime).getTime() - Date.now() : 0;

    const tick = () => {
      setElapsed(Math.max(0, Math.floor((Date.now() + offsetMs - startedMs) / 1000)));
    };

    tick();
    // Align to the next whole second so the first flip is not a fraction early.
    let interval = window.setTimeout(function run() {
      tick();
      interval = window.setTimeout(run, 1000);
    }, 1000 - (Date.now() % 1000));

    return () => {
      window.clearTimeout(interval);
    };
  }, [startedAt, serverTime]);

  return elapsed;
}

export function TimerBar() {
  const { data } = useRunningTimer();
  const invalidate = useInvalidate();
  const [pausing, setPausing] = useState<number | null>(null);

  const running = data?.running ?? [];

  if (running.length === 0) return null;

  const pause = async (logId: number) => {
    setPausing(logId);
    try {
      await api("/timer/pause", { method: "POST", json: { log_id: logId } });
      await invalidate();
    } finally {
      setPausing(null);
    }
  };

  return (
    <div className="sticky bottom-0 z-30 border-t border-border bg-card/95 backdrop-blur">
      <div className="mx-auto max-w-7xl px-4 py-2.5">
        {running.length > 1 ? (
          <p className="pb-1 text-xs text-muted-foreground">
            {running.length} timers running at once
          </p>
        ) : null}
        <ul className="flex flex-col gap-1">
          {running.map((timer) => (
            <TimerLine
              key={timer.log_id}
              timer={timer}
              serverTime={data?.server_time}
              onPause={() => void pause(timer.log_id)}
              pausing={pausing === timer.log_id}
            />
          ))}
        </ul>
      </div>
    </div>
  );
}

function TimerLine({
  timer,
  serverTime,
  onPause,
  pausing,
}: {
  timer: RunningTimer;
  serverTime: string | undefined;
  onPause: () => void;
  pausing: boolean;
}) {
  const elapsed = useElapsed(timer.started_at, serverTime);

  return (
    <li className="flex flex-wrap items-center gap-3">
      <span className="relative flex h-2.5 w-2.5">
        <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-success opacity-75" />
        <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-success" />
      </span>
      <span className="tabular text-sm font-semibold">{formatClock(elapsed)}</span>
      <Link
        href={`/tasks/${timer.task_id}`}
        className="min-w-0 flex-1 truncate text-sm text-muted-foreground hover:text-foreground"
      >
        {timer.task_title}
      </Link>
      {timer.is_stale ? (
        <span className="inline-flex items-center gap-1 text-xs text-warning">
          <TriangleAlert className="h-3.5 w-3.5" aria-hidden />
          Stale — enter the real end time
        </span>
      ) : null}
      <Button size="sm" variant="outline" onClick={onPause} loading={pausing}>
        <Pause className="h-4 w-4" aria-hidden />
        Pause
      </Button>
      <Link href={`/tasks/${timer.task_id}`}>
        <Button size="sm" variant="ghost">
          <Play className="h-4 w-4" aria-hidden />
          Open
        </Button>
      </Link>
    </li>
  );
}

export function useSessionTimezone() {
  return useAuth().appTimezone;
}