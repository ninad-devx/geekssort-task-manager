"use client";

import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, ArrowUpRight } from "lucide-react";
import Link from "next/link";
import { useState } from "react";

import { PageHeader, roleLabel } from "@/components/app-shell";
import { Avatar, displayName } from "@/components/avatar";
import { Card, CardContent, EmptyState, ErrorState, Spinner } from "@/components/ui/card";
import { Badge, Input } from "@/components/ui/form";
import { api, ApiError } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { formatHours } from "@/lib/format";
import type { DirectoryEntry, DashboardPayload } from "@/lib/types";

/**
 * The roster, and the entry point to each person's own dashboard.
 *
 * Every name here opens the same profile page the person sees for themselves,
 * so a lead reads exactly what the team member reads -- there is no separate
 * "manager view" of somebody's numbers that can quietly disagree with theirs.
 */
export default function PeoplePage() {
  const { capabilities } = useAuth();
  const [search, setSearch] = useState("");

  const directory = useQuery({
    queryKey: ["directory"],
    queryFn: () => api<DirectoryEntry[]>("/users/directory"),
  });

  // The same payload the dashboard uses, so a lead sees the team's day as the
  // dashboard describes it rather than a second, differently-scoped roll-up.
  const team = useQuery({
    queryKey: ["dashboard", "executive", "today"],
    queryFn: () => api<DashboardPayload>("/dashboard/executive?period=today"),
    enabled: !!capabilities?.can_view_team,
  });

  if (!capabilities?.can_view_team) {
    return (
      <EmptyState
        title="Not available for your role"
        description="The team roster is visible to the CEO and team lead. Your own profile is always on your name in the top bar."
      />
    );
  }

  if (directory.isLoading || team.isLoading) return <Spinner label="Loading the roster" />;
  if (directory.isError) {
    return (
      <ErrorState
        message={
          directory.error instanceof ApiError ? directory.error.message : "Could not load people."
        }
        onRetry={() => void directory.refetch()}
      />
    );
  }

  const all = directory.data ?? [];
  const needle = search.trim().toLowerCase();
  const people = needle
    ? all.filter(
        (p) =>
          p.full_name.toLowerCase().includes(needle) ||
          (p.display_name ?? "").toLowerCase().includes(needle),
      )
    : all;

  const loadByUser = new Map(
    (team.data?.members ?? []).map((m) => [m.user.id, m] as const),
  );

  return (
    <>
      <PageHeader
        title="People"
        description="Every profile, with what each person is carrying today. Open one for their full day-by-day history."
        actions={
          <div className="relative min-w-[200px]">
            <Input
              className="h-10 w-full rounded-full bg-card pl-4"
              type="search"
              placeholder="Search people…"
              aria-label="Search people"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
        }
      />

      {people.length === 0 ? (
        <EmptyState title="Nobody matches" description="Try a different name." />
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {people.map((person) => {
            const load = loadByUser.get(person.id);
            return (
              <Link
                key={person.id}
                href={`/users/${person.id}`}
                className="group block focus-visible:outline-none"
              >
                <Card className="h-full transition-all group-hover:border-[#145338]/40">
                  <CardContent className="flex h-full flex-col gap-3 p-5">
                    <div className="flex items-start gap-3">
                      <Avatar person={person} size="md" />
                      <div className="min-w-0 flex-1">
                        <p className="truncate font-bold text-foreground group-hover:text-[#145338]">
                          {displayName(person)}
                        </p>
                        <p className="text-xs text-muted-foreground">
                          {roleLabel(person.role)}
                          {person.is_active ? "" : " · Deactivated"}
                        </p>
                      </div>
                      <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-muted/80 text-muted-foreground transition-colors group-hover:bg-[#145338] group-hover:text-white">
                        <ArrowUpRight className="h-4 w-4" aria-hidden />
                      </span>
                    </div>

                    <div className="mt-auto grid grid-cols-3 gap-2 border-t border-border/60 pt-3 text-center">
                      <div>
                        <p className="tabular text-lg font-bold text-foreground">
                          {load?.open_tasks ?? 0}
                        </p>
                        <p className="text-[10px] text-muted-foreground">Open</p>
                      </div>
                      <div>
                        <p
                          className={`tabular text-lg font-bold ${
                            (load?.overdue_count ?? 0) > 0
                              ? "text-destructive"
                              : "text-foreground"
                          }`}
                        >
                          {load?.overdue_count ?? 0}
                        </p>
                        <p className="text-[10px] text-muted-foreground">Overdue</p>
                      </div>
                      <div>
                        <p className="tabular text-lg font-bold text-foreground">
                          {formatHours(load?.tracked_seconds ?? 0)}
                        </p>
                        <p className="text-[10px] text-muted-foreground">Today</p>
                      </div>
                    </div>

                    {(load?.overdue_count ?? 0) > 0 ? (
                      <Badge variant="danger" className="self-start">
                        <AlertTriangle className="mr-1 h-3 w-3" aria-hidden />
                        Needs attention
                      </Badge>
                    ) : (load?.due_today_count ?? 0) > 0 ? (
                      <Badge variant="warning" className="self-start">
                        {load?.due_today_count} due today
                      </Badge>
                    ) : null}
                  </CardContent>
                </Card>
              </Link>
            );
          })}
        </div>
      )}

      {team.isError ? (
        <p className="mt-4 text-sm text-muted-foreground">
          Today&rsquo;s team figures are unavailable; the profiles themselves still open.
        </p>
      ) : null}
    </>
  );
}