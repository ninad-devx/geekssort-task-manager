"use client";

import { useQuery } from "@tanstack/react-query";
import { Bell } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";

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

/**
 * Always runs.
 *
 * This used to be `enabled: since !== undefined`, and `since` comes from
 * localStorage. For anyone who had never opened the bell the flag was unset,
 * `since` was undefined, the query never fired, and the whole feature -- badge,
 * panel and banner -- was inert until a first click that only a person hunting
 * for it would make. Fetching unconditionally is what makes it work.
 */
function useNotifications(since: string | null) {
  return useQuery({
    queryKey: ["notifications", since ?? "all"],
    queryFn: () =>
      api<NotificationList>(
        `/notifications${since ? `?since=${encodeURIComponent(since)}` : ""}`,
      ),
    refetchInterval: 30_000,
    refetchOnWindowFocus: true,
  });
}

export function NotificationBell() {
  const [seenRaw, setSeen] = useStoredFlag(SEEN_KEY);
  const [soundRaw, setSoundRaw] = useStoredFlag(SOUND_KEY);
  const soundOn = soundRaw === "on";
  const [open, setOpen] = useState(false);
  const wrapper = useRef<HTMLDivElement>(null);

  const seen = seenRaw ?? null;
  const { data } = useNotifications(seen);
  const items = useMemo(() => data?.items ?? [], [data]);

  // Until this device has a watermark we cannot say any of this is *new*, so
  // there is no badge. The list is still fully readable.
  const unread = seen ? items.length : 0;

  const markSeen = useCallback(() => {
    if (seen && data) return;
    setSeen(data?.server_time ?? new Date().toISOString());
  }, [seen, data, setSeen]);

  // Opening and reading are separate things. `markSeen` used to run on click
  // and on every item click, which immediately emptied the list and unmounted
  // the panel -- so the bell could never be opened twice.
  const dismiss = useCallback(() => {
    setOpen(false);
    markSeen();
  }, [markSeen]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!wrapper.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") dismiss();
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, dismiss]);

  // Chime once per genuinely new arrival. The previous effect keyed off
  // `fresh.length`, so `toggleSound` and the effect both fired and every page
  // load replayed the sound.
  const chimed = useRef<string | null>(null);
  useEffect(() => {
    if (!seen || !soundOn || items.length === 0) return;
    const newest = String(items[0].id);
    if (newest === chimed.current) return;
    chimed.current = newest;
    playChime();
  }, [seen, soundOn, items]);

  const toggleSound = () => setSoundRaw(soundOn ? "off" : "on");

  return (
    <div className="relative flex items-center" ref={wrapper}>
      <button
        type="button"
        onClick={() => (open ? dismiss() : setOpen(true))}
        className="relative flex h-10 w-10 items-center justify-center rounded-full border border-border/70 bg-card text-foreground shadow-2xs transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        title={unread ? `${unread} new` : "Notifications"}
        aria-label={unread ? `Notifications, ${unread} new` : "Notifications"}
        aria-expanded={open}
        aria-haspopup="dialog"
      >
        <Bell className="h-[18px] w-[18px] text-muted-foreground" aria-hidden />
        {unread > 0 ? (
          <span className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-[#145338] px-1 text-[10px] font-semibold text-white">
            {unread > 99 ? "99+" : unread}
          </span>
        ) : null}
      </button>

      {open ? (
        <div
          role="dialog"
          aria-label="Notifications"
          className="absolute right-0 top-full z-50 mt-2 w-80 rounded-2xl border border-border bg-card p-3 shadow-xl"
        >
          <div className="flex items-center justify-between border-b border-border/60 pb-2">
            <p className="text-xs font-semibold text-foreground">
              {unread > 0 ? `${unread} new` : "Assigned to you"}
            </p>
            <div className="flex items-center gap-3">
              <label className="flex cursor-pointer items-center gap-1 text-[11px] text-muted-foreground">
                <input
                  type="checkbox"
                  checked={soundOn}
                  onChange={toggleSound}
                  className="h-3 w-3 accent-[#145338]"
                />
                sound
              </label>
              {items.length > 0 ? (
                <button
                  type="button"
                  onClick={markSeen}
                  className="text-xs font-medium text-[#145338] hover:underline"
                >
                  Mark all read
                </button>
              ) : null}
            </div>
          </div>
          {items.length === 0 ? (
            <p className="px-2 py-5 text-center text-sm text-muted-foreground">
              Nothing has been assigned to you yet.
            </p>
          ) : (
            <ul className="mt-1.5 max-h-72 space-y-0.5 overflow-y-auto">
              {items.slice(0, 20).map((n) => (
                <li key={n.id}>
                  <Link
                    href={`/tasks/${n.task_id}`}
                    className="flex items-center gap-2 rounded-xl px-2.5 py-2 text-sm transition-colors hover:bg-muted"
                    onClick={dismiss}
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-medium text-foreground">
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
          )}
        </div>
      ) : null}
    </div>
  );
}

/** A pinned strip under the header while an assignment is unread. */
export function AssignmentBanner() {
  const [seenRaw, setSeen] = useStoredFlag(SEEN_KEY);
  const seen = seenRaw ?? null;
  const { data } = useNotifications(seen);
  const items = data?.items ?? [];

  if (!seen || items.length === 0) return null;

  const dismiss = () => setSeen(data?.server_time ?? new Date().toISOString());

  return (
    <div className="mb-4 rounded-2xl border border-[#145338]/20 bg-[#eaf4ef] px-4 py-2.5">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <Bell className="h-4 w-4 text-[#145338]" aria-hidden />
        <span className="font-medium text-[#145338]">
          {items.length} new {items.some((n) => n.is_reminder) ? "reminder" : "task"}
          {items.length === 1 ? "" : "s"} assigned to you
        </span>
        {items.slice(0, 3).map((n) => (
          <Link
            key={n.id}
            href={`/tasks/${n.task_id}`}
            className="inline-flex items-center gap-1 font-medium text-foreground underline-offset-2 hover:underline"
            onClick={dismiss}
          >
            {n.task_title}
            <span className="text-xs text-muted-foreground">({n.actor_name})</span>
          </Link>
        ))}
        <button
          type="button"
          onClick={dismiss}
          className="ml-auto text-xs font-medium text-[#145338] hover:underline"
        >
          Dismiss
        </button>
      </div>
    </div>
  );
}