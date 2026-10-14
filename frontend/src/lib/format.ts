/** Formatting helpers. The server sends UTC; the browser converts for display (rule 6). */

const naiveUtc = (value: string): Date => {
  // API timestamps are UTC ISO-8601 but may lack the Z suffix
  const hasZone = /(?:Z|[+-]\d{2}:?\d{2})$/.test(value);
  return new Date(hasZone ? value : `${value}Z`);
};

export function parseUtc(value: string): Date {
  return naiveUtc(value);
}

export function formatDateTime(value: string | null | undefined, timeZone?: string): string {
  if (!value) return "—";
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone,
  }).format(naiveUtc(value));
}

/** "14 Jan 2026, 12:10 AM" — the readable form people actually asked for. */
export function formatReadable(value: string | null | undefined, timeZone?: string): string {
  if (!value) return "—";
  return new Intl.DateTimeFormat(undefined, {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
    timeZone,
  }).format(naiveUtc(value));
}

export function formatDate(value: string | null | undefined, timeZone?: string): string {
  if (!value) return "—";
  const d = value.length === 10 ? new Date(`${value}T12:00:00Z`) : naiveUtc(value);
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeZone }).format(d);
}

/** "2026-01-05T14:30" in the local zone, for datetime-local inputs. */
export function toLocalInput(value: string | null | undefined): string {
  if (!value) return "";
  const d = naiveUtc(value);
  const offset = d.getTimezoneOffset() * 60_000;
  return new Date(d.getTime() - offset).toISOString().slice(0, 16);
}

export function fromLocalInput(value: string): string {
  return new Date(value).toISOString().replace(/\.\d{3}Z$/, "");
}

export function formatDuration(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined) return "—";
  if (seconds < 60) return `${seconds}s`;
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (hours === 0) return `${minutes}m`;
  return `${hours}h ${String(minutes).padStart(2, "0")}m`;
}

export function formatClock(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

export function formatHours(seconds: number): string {
  return `${(seconds / 3600).toFixed(1)} h`;
}

export function overdueDays(dueDate: string | null, today: string): number | null {
  if (!dueDate) return null;
  const due = new Date(`${dueDate}T00:00:00Z`).getTime();
  const now = new Date(`${today}T00:00:00Z`).getTime();
  const days = Math.round((now - due) / 86_400_000);
  return days > 0 ? days : null;
}