"use client";

import { cn } from "@/lib/utils";

/** Stable pastel per name, so the same person is the same colour everywhere. */
const FALLBACKS = [
  "#0ea5e9",
  "#8b5cf6",
  "#ec4899",
  "#f97316",
  "#10b981",
  "#eab308",
  "#6366f1",
  "#ef4444",
];

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

function colorFor(name: string, id: number): string {
  let hash = 0;
  for (let i = 0; i < name.length; i += 1) hash = (hash * 31 + name.charCodeAt(i)) % 997;
  return FALLBACKS[(hash + id) % FALLBACKS.length];
}

export function displayName(
  person: { full_name: string; display_name?: string | null },
): string {
  return person.display_name?.trim() || person.full_name;
}

export function Avatar({
  person,
  size = "md",
  className,
}: {
  person: { id: number; full_name: string; display_name?: string | null; avatar_url?: string | null; avatar_color?: string | null };
  size?: "xs" | "sm" | "md";
  className?: string;
}) {
  const name = displayName(person);
  const sizes = {
    xs: "h-5 w-5 text-[9px]",
    sm: "h-7 w-7 text-[11px]",
    md: "h-9 w-9 text-xs",
  } as const;

  const classes = cn(
    "inline-flex shrink-0 items-center justify-center overflow-hidden rounded-full font-semibold text-white",
    sizes[size],
    className,
  );

  if (person.avatar_url) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img src={person.avatar_url} alt={name} title={name} className={classes} />
    );
  }

  return (
    <span
      className={classes}
      style={{ backgroundColor: person.avatar_color || colorFor(name, person.id) }}
      title={name}
      aria-label={name}
    >
      {initials(name)}
    </span>
  );
}

/** Avatar plus the name, used wherever a person is named in the UI. */
export function PersonTag({
  person,
  size = "sm",
  showName = true,
}: {
  person: { id: number; full_name: string; display_name?: string | null; avatar_url?: string | null; avatar_color?: string | null };
  size?: "xs" | "sm" | "md";
  showName?: boolean;
}) {
  return (
    <span className="inline-flex min-w-0 items-center gap-2">
      <Avatar person={person} size={size} />
      {showName ? <span className="truncate">{displayName(person)}</span> : null}
    </span>
  );
}