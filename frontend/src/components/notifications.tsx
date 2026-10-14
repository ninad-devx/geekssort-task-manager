"use client";

import { useQuery } from "@tanstack/react-query";
import { Bell } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useRef, useSyncExternalStore } from "react";

import { Badge } from "@/components/ui/form";
import { api } from "@/lib/api";
import { STATUS_LABELS, type NotificationList } from "@/lib/types";

const SEEN_KEY = "mos.notifications.seen";
const SOUND_KEY = "mos.notifications.sound";
const PING_EVENT = "mos-notifications-change";

function subscribe(onChange: () => void) {
  window.addEventListener("storage", onChange);
  window.addEventListener(PING_EVENT, onChange);
  return () => {
    window.removeEventListener("storage", onChange);
    window.removeEventListener(PING_EVENT, onChange);
  };
}

function readKey(key: string): string | null {
  return window.localStorage.getItem(key);
}

function writeKey(key: string, value: string | null) {
  if (value === null) window.localStorage.removeItem(key);
  else window.localStorage.setItem(key, value);
  window.dispatchEvent(new Event(PING_EVENT));
}

/**
 * localStorage read through useSyncExternalStore rather than state + effect:
 * the server snapshot is undefined, so the markup matches on first paint and
 * the real value arrives without a cascading render.
 */
function useStoredFlag(key: string): [string | null, (value: string | null) => void] {
  const value = useSyncExternalStore(
    subscribe,
    () => readKey(key),
    () => null,
  );
  const set = useCallback((next: string | null) => writeKey(key, next), [key]);
  return [value, set];
}

function useSeenSince() {
  const [seen, setSeen] = useStoredFlag(SEEN_KEY);
  return [seen ?? undefined, setSeen] as const;
}

/** A short, quiet chime synthesised locally so no audio asset has to ship. */
function playChime() {
  try {
    const Ctor =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return;
    const ctx = new Ctor();
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.1, ctx.currentTime + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.4);
    gain.connect(ctx.destination);
    [660, 880].forEach((freq, i) => {
      const osc = ctx.createOscillator();
      osc.type = "sine";
      osc.frequency.value = freq;
      osc.connect(gain);
      osc.start(ctx.currentTime + i * 0.09);
      osc.stop(ctx.currentTime + 0.4);
    });
    setTimeout(() => void ctx.close(), 700);
  } catch {
    // Audio is a nicety; never let it break the page.
  }
}

function useNotifications(since: string | undefined) {
  return useQuery({
    queryKey: ["notifications", since ?? "all"],
    queryFn: () =>
      api<NotificationList>(
        `/notifications${since ? `?since=${encodeURIComponent(since)}` : ""}`,
      ),
    refetchInterval: 30_000,
    enabled: since !== undefined,
  });
}

export function NotificationBell() {
  const [since, setSeen] = useSeenSince();
  const [soundRaw, setSoundRaw] = useStoredFlag(SOUND_KEY);
  const soundOn = soundRaw === "on";
  const primed = useRef(false);

  const { data } = useNotifications(since);
  const fresh = data?.items ?? [];

  // Sound once the user has opted in, and only for genuinely new arrivals.
  useEffect(() => {
    if (!primed.current) {
      primed.current = true;
      return;
    }
    if (soundOn && fresh.length > 0) playChime();
  }, [fresh.length, soundOn]);

  const markSeen = () => setSeen(data?.server_time ?? new Date().toISOString());

  const toggleSound = () => {
    const next = !soundOn;
    setSoundRaw(next ? "on" : "off");
    if (next) playChime();
  };

  const visible = fresh.slice(0, 8);

  return (
    <div className="relative flex flex-col items-center">
      <button
        type="button"
        onClick={markSeen}
        className="relative rounded-full p-2 hover:bg-muted"
        title="Mark notifications as seen"
        aria-label={`Notifications${fresh.length ? `, ${fresh.length} new` : ""}`}
      >
        <Bell className="h-5 w-5" aria-hidden />
        {fresh.length > 0 ? (
          <span className="absolute right-0 top-0 flex h-4 min-w-4 items-center justify-center rounded-full bg-destructive px-1 text-[10px] font-semibold text-white">
            {fresh.length}
          </span>
        ) : null}
      </button>
      <label className="flex cursor-pointer items-center gap-1 text-[10px] text-muted-foreground">
        <input type="checkbox" checked={soundOn} onChange={toggleSound} className="h-3 w-3" />
        sound
      </label>

      {visible.length > 0 ? (
        <div className="absolute right-0 top-full z-50 mt-1 w-80 rounded-lg border border-border bg-card p-2 shadow-lg">
          <p className="px-2 py-1 text-xs font-medium text-muted-foreground">Assigned to you</p>
          <ul className="max-h-72 overflow-y-auto">
            {visible.map((n) => (
              <li key={n.id}>
                <Link
                  href={`/tasks/${n.task_id}`}
                  className="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-muted"
                  onClick={markSeen}
                >
                  <span className="min-w-0 flex-1">
                    <span className="block truncate">
                      {n.is_reminder ? "Reminder: " : ""}
                      {n.task_title}
                    </span>
                    <span className="block text-xs text-muted-foreground">
                      {n.is_reminder ? "needs your attention — from " : "from "}
                      {n.actor_name}
                      {n.message ? `: ${n.message}` : ""}
                    </span>
                  </span>
                  <Badge variant="outline">{STATUS_LABELS[n.task_status]}</Badge>
                </Link>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

/** A pinned strip under the header while an assignment is unread. */
export function AssignmentBanner() {
  const [since, setSeen] = useSeenSince();
  const { data } = useNotifications(since);
  const items = data?.items ?? [];

  if (since === undefined || items.length === 0) return null;

  return (
    <div className="border-b border-warning/40 bg-warning/10 px-4 py-2">
      <div className="mx-auto flex max-w-7xl flex-wrap items-center gap-2 text-sm">
        <Bell className="h-4 w-4 text-warning" aria-hidden />
        <span className="font-medium">
          {items.length} new {items.some((n) => n.is_reminder) ? "reminder" : "task"}
          {items.length === 1 ? "" : "s"} assigned to you
        </span>
        {items.slice(0, 3).map((n) => (
          <Link
            key={n.id}
            href={`/tasks/${n.task_id}`}
            className="inline-flex items-center gap-1 underline-offset-2 hover:underline"
            onClick={() => setSeen(data?.server_time ?? new Date().toISOString())}
          >
            {n.is_reminder ? "🔔 " : ""}
            {n.task_title}
            <span className="text-xs text-muted-foreground">({n.actor_name})</span>
          </Link>
        ))}
        <button
          type="button"
          onClick={() => setSeen(data?.server_time ?? new Date().toISOString())}
          className="ml-auto text-xs text-muted-foreground hover:text-foreground"
        >
          Dismiss
        </button>
      </div>
    </div>
  );
}