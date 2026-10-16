/** Formatting helpers. The server sends UTC; the browser converts for display (rule 6). */

const naiveUtc = (value: string): Date => {
  // API timestamps are UTC ISO-8601 but may lack the Z suffix.
  // A bare date ("2026-01-05") gets a time component too: appending "Z" to it
  // yields "2026-01-05Z", which V8 rejects as an invalid date and which then
  // makes Intl throw a RangeError.
  const hasZone = /(?:Z|[+-]\d{2}:?\d{2})$/.test(value);
  if (hasZone) return new Date(value);
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return new Date(`${value}T00:00:00Z`);
  return new Date(`${value}Z`);
};

export function parseUtc(value: string): Date {
  return naiveUtc(value);
}

/**
 * Today, in the *viewer's* zone, as "YYYY-MM-DD".
 *
 * Every caller used `new Date().toISOString().slice(0, 10)`, which is UTC. West
 * of Greenwich that reads as tomorrow after the evening, so every task due
 * today was badged "Overdue 1d". A due date is a calendar date, so it has to be
 * compared against the reader's calendar, not Greenwich's.
 */
export function todayLocal(): string {
  const now = new Date();
  const offset = now.getTimezoneOffset() * 60_000;
  return new Date(now.getTime() - offset).toISOString().slice(0, 10);
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
  const d = naiveUtc(value);
  if (Number.isNaN(d.getTime())) return "—";
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeZone }).format(d);
}

/** "2026-01-05T14:30" in the local zone, for datetime-local inputs. */
export function toLocalInput(value: string | null | undefined): string {
  if (!value) return "";
  const d = naiveUtc(value);
  if (Number.isNaN(d.getTime())) return "";
  const offset = d.getTimezoneOffset() * 60_000;
  return new Date(d.getTime() - offset).toISOString().slice(0, 16);
}

/**
 * The inverse. Returns "" for an empty field rather than throwing on
 * `new Date("")` -- the dialogs used to let an empty datetime-local through to
 * here, which raised a RangeError that surfaced as a generic failure toast.
 */
export function fromLocalInput(value: string): string {
  if (!value) return "";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "";
  return d.toISOString().replace(/\.\d{3}Z$/, "");
}

export function formatDuration(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined) return "—";
  // A negative value used to render as "-30s".
  const total = Math.max(0, Math.round(seconds));
  if (total < 60) return `${total}s`;
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  if (hours === 0) return `${minutes}m`;
  return `${hours}h ${String(minutes).padStart(2, "0")}m`;
}

export function formatClock(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = Math.floor(total % 60);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

export function formatHours(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined) return "0.0 h";
  return `${(Math.max(0, seconds) / 3600).toFixed(1)} h`;
}

/** Days past a due date, or null when it is not yet late. `today` is "YYYY-MM-DD". */
export function overdueDays(dueDate: string | null, today: string): number | null {
  if (!dueDate) return null;
  const due = new Date(`${dueDate}T00:00:00Z`).getTime();
  const now = new Date(`${today}T00:00:00Z`).getTime();
  if (Number.isNaN(due) || Number.isNaN(now)) return null;
  const days = Math.round((now - due) / 86_400_000);
  return days > 0 ? days : null;
}

/** "Mon 5 Jan" — a readable axis label that is not a bare "01-05". */
export function formatDayLabel(day: string): string {
  const d = new Date(`${day}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return day;
  return new Intl.DateTimeFormat(undefined, {
    weekday: "short",
    day: "numeric",
    month: "short",
    timeZone: "UTC",
  }).format(d);
}