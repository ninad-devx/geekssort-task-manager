"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  Clock,
  FolderKanban,
  Plus,
  Search,
  Users,
} from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";

import { PageHeader, roleLabel } from "@/components/app-shell";
import { Avatar, displayName } from "@/components/avatar";
import { CreateTaskDialog, Pager } from "@/components/tasks/task-dialogs";
import { TaskRow } from "@/components/tasks/task-ui";
import { Button } from "@/components/ui/button";
import { Card, CardContent, EmptyState, ErrorState, Spinner } from "@/components/ui/card";
import { Badge, Input, Select } from "@/components/ui/form";
import { api, ApiError, qs } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { formatDuration, formatHours, todayLocal } from "@/lib/format";
import {
  CATEGORY_LABELS,
  PRIORITY_LABELS,
  STATUS_LABELS,
  type DirectoryEntry,
  type TaskBoard,
  type TaskList,
} from "@/lib/types";

const PAGE_SIZE = 50;

function TeamTasksInner() {
  const router = useRouter();
  const params = useSearchParams();
  const client = useQueryClient();
  const { capabilities } = useAuth();

  const [page, setPage] = useState(1);
  const [createOpen, setCreateOpen] = useState(false);
  // "off" | "with" (live + deleted) | "only" (deleted alone). `include_deleted`
  // alone returned both sets mixed together, so asking "what did we delete?"
  // was not answerable.
  const [deleted, setDeleted] = useState<"off" | "with" | "only">("off");
  const [view, setView] = useState<"board" | "list">("board");
  const [openPerson, setOpenPerson] = useState<number | null>(null);

  const filters = {
    status: params.get("status") ?? "",
    priority: params.get("priority") ?? "",
    assignee_id: params.get("assignee_id") ?? "",
    category: params.get("category") ?? "",
    overdue: params.get("overdue") ?? "",
    completed_from: params.get("completed_from") ?? "",
    completed_to: params.get("completed_to") ?? "",
    q: params.get("q") ?? "",
  };

  const setFilter = (key: string, value: string) => {
    const next = new URLSearchParams(params.toString());
    if (value) next.set(key, value);
    else next.delete(key);
    setPage(1);
    router.replace(`/team-tasks?${next.toString()}`);
  };

  /**
   * Search text is held locally and committed to the URL on a pause.
   */
  const [queryDraft, setQueryDraft] = useState(filters.q);
  const [syncedQuery, setSyncedQuery] = useState(filters.q);
  if (filters.q !== syncedQuery) {
    setSyncedQuery(filters.q);
    setQueryDraft(filters.q);
  }
  useEffect(() => {
    if (queryDraft === filters.q) return;
    const timer = setTimeout(() => setFilter("q", queryDraft), 300);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queryDraft]);

  const tasks = useQuery({
    queryKey: ["tasks", "team", page, filters, deleted],
    queryFn: () =>
      api<TaskList>(
        `/tasks${qs({
          ...filters,
          page,
          page_size: PAGE_SIZE,
          include_deleted: deleted === "with" ? true : undefined,
          deleted_only: deleted === "only" ? true : undefined,
        })}`,
      ),
    enabled: view === "list",
  });

  const board = useQuery({
    queryKey: ["tasks", "board", filters],
    queryFn: () =>
      api<TaskBoard>(
        `/tasks/board${qs({
          ...filters,
          include_completed: filters.completed_from || filters.completed_to ? true : undefined,
        })}`,
      ),
    enabled: view === "board",
  });

  const directory = useQuery({
    queryKey: ["directory"],
    queryFn: () => api<DirectoryEntry[]>("/users/directory"),
  });

  if (!capabilities?.can_view_team) {
    return (
      <EmptyState
        title="Not available for your role"
        description="Team tasks are visible to the CEO and team lead."
      />
    );
  }

  const invalidate = () => {
    void client.invalidateQueries({ queryKey: ["tasks"] });
  };
  const today = todayLocal();
  const total = tasks.data?.total ?? 0;

  const people = board.data?.people ?? [];
  const totalOpenBoard = people.reduce((acc, p) => acc + p.open_count, 0) + (board.data?.unassigned_count ?? 0);
  const totalOverdueBoard = people.reduce((acc, p) => acc + p.overdue_count, 0);
  const totalTrackedBoard = people.reduce((acc, p) => acc + p.tracked_seconds, 0);

  return (
    <>
      <PageHeader
        title="Team Tasks"
        description="Every task in the company, grouped by the person carrying it."
        actions={
          <>
            <Button variant="outline" onClick={() => setView(view === "board" ? "list" : "board")}>
              {view === "board" ? "Flat list" : "By person"}
            </Button>
            <Button
              variant="outline"
              onClick={() => setDeleted(deleted === "off" ? "with" : deleted === "with" ? "only" : "off")}
              aria-label={`Deleted tasks: ${deleted === "off" ? "hidden" : deleted === "with" ? "shown with live tasks" : "shown on their own"}`}
            >
              {deleted === "off" ? "Hide deleted" : deleted === "with" ? "Show deleted only" : "Show deleted too"}
            </Button>
            {capabilities.can_create_tasks ? (
              <Button onClick={() => setCreateOpen(true)}>
                <Plus className="h-4 w-4" aria-hidden />
                New Task
              </Button>
            ) : null}
          </>
        }
      />

      {/* Team Summary Strip */}
      <div className="mb-5 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <div className="flex items-center justify-between rounded-2xl p-5 hero-green-card shadow-[0_8px_24px_rgba(20,83,56,0.18)]">
          <div>
            <p className="text-xs font-medium text-white/85">
              {view === "board" ? "Open Team Tasks" : "Matching Tasks"}
            </p>
            <p className="mt-1 tabular text-3xl font-bold text-white">
              {view === "board" ? totalOpenBoard : total}
            </p>
            <p className="mt-1 text-xs text-[#a9dfc2]">
              {board.data?.unassigned_count
                ? `${board.data.unassigned_count} unassigned`
                : "Across active assignees"}
            </p>
          </div>
          <span className="flex h-10 w-10 items-center justify-center rounded-2xl bg-white/15 text-white">
            <FolderKanban className="h-5 w-5" aria-hidden />
          </span>
        </div>

        <Card className="flex items-center justify-between p-5">
          <div>
            <p className="text-xs font-medium text-muted-foreground">Active Assignees</p>
            <p className="mt-1 tabular text-3xl font-bold text-foreground">{people.length}</p>
            <p className="mt-1 text-xs text-[#1f7a52]">Carrying open tasks</p>
          </div>
          <span className="flex h-10 w-10 items-center justify-center rounded-2xl bg-[#eaf4ef] text-[#145338]">
            <Users className="h-5 w-5" aria-hidden />
          </span>
        </Card>

        <Card className="flex items-center justify-between p-5">
          <div>
            <p className="text-xs font-medium text-muted-foreground">Overdue Tasks</p>
            <p
              className={`mt-1 tabular text-3xl font-bold ${
                totalOverdueBoard > 0 ? "text-destructive" : "text-foreground"
              }`}
            >
              {totalOverdueBoard}
            </p>
            <p className="mt-1 text-xs text-muted-foreground">Needs attention</p>
          </div>
          <span
            className={`flex h-10 w-10 items-center justify-center rounded-2xl ${
              totalOverdueBoard > 0
                ? "bg-[#fdecee] text-destructive"
                : "bg-[#eaf4ef] text-[#145338]"
            }`}
          >
            <AlertTriangle className="h-5 w-5" aria-hidden />
          </span>
        </Card>

        <Card className="flex items-center justify-between p-5">
          <div>
            <p className="text-xs font-medium text-muted-foreground">Tracked on Open Work</p>
            <p className="mt-1 tabular text-3xl font-bold text-foreground">
              {formatHours(totalTrackedBoard)}
            </p>
            <p className="mt-1 text-xs text-[#1f7a52]">Logged across board</p>
          </div>
          <span className="flex h-10 w-10 items-center justify-center rounded-2xl bg-[#eaf4ef] text-[#145338]">
            <Clock className="h-5 w-5" aria-hidden />
          </span>
        </Card>
      </div>

      {/* Filter Bar Card */}
      <Card className="mb-5 p-3.5">
        <div className="flex flex-wrap items-center gap-2.5">
          <div className="relative min-w-[200px] flex-1 max-w-xs">
            <Search
              className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
              aria-hidden
            />
            <Input
              className="h-9 rounded-full bg-[#f7f8f9] pl-9"
              type="search"
              placeholder="Search by title…"
              aria-label="Search tasks by title"
              value={queryDraft}
              onChange={(e) => setQueryDraft(e.target.value)}
            />
          </div>
          <Select
            className="h-9 w-auto rounded-full px-4"
            value={filters.status}
            onChange={(e) => setFilter("status", e.target.value)}
          >
            <option value="">All statuses</option>
            {Object.entries(STATUS_LABELS).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </Select>
          <Select
            className="h-9 w-auto rounded-full px-4"
            value={filters.priority}
            onChange={(e) => setFilter("priority", e.target.value)}
          >
            <option value="">All priorities</option>
            {Object.entries(PRIORITY_LABELS).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </Select>
          <Select
            className="h-9 w-auto rounded-full px-4"
            value={filters.assignee_id}
            onChange={(e) => setFilter("assignee_id", e.target.value)}
          >
            <option value="">Everyone</option>
            {(directory.data ?? []).map((entry) => (
              <option key={entry.id} value={entry.id}>
                {entry.full_name}
              </option>
            ))}
          </Select>
          <Select
            className="h-9 w-auto rounded-full px-4"
            value={filters.category}
            onChange={(e) => setFilter("category", e.target.value)}
          >
            <option value="">All categories</option>
            {Object.entries(CATEGORY_LABELS).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </Select>
          <Button
            variant={filters.overdue ? "default" : "outline"}
            size="sm"
            onClick={() => setFilter("overdue", filters.overdue ? "" : "true")}
          >
            Overdue only
          </Button>
          {filters.completed_from || filters.completed_to ? (
            <Badge variant="outline">
              Completed {filters.completed_from || "…"} → {filters.completed_to || "…"}
            </Badge>
          ) : null}
          <Button variant="ghost" size="sm" onClick={() => router.replace("/team-tasks")}>
            Clear
          </Button>
        </div>
      </Card>

      {view === "board" ? (
        board.isLoading ? (
          <Spinner label="Loading the team board" />
        ) : board.isError ? (
          <ErrorState
            message={
              board.error instanceof ApiError ? board.error.message : "Could not load the team board."
            }
            onRetry={() => void board.refetch()}
          />
        ) : people.length === 0 && board.data?.unassigned_count === 0 ? (
          <EmptyState
            title="Nothing assigned right now"
            description="When work is assigned it appears here, grouped by person."
          />
        ) : (
          <div className="space-y-3">
            {people.map((person) => {
              const expanded = openPerson === person.user.id;
              return (
                <Card key={person.user.id} className="overflow-hidden transition-all hover:border-[#145338]/30">
                  <CardContent className="p-0">
                    <button
                      type="button"
                      className="flex w-full flex-wrap items-center gap-3.5 px-5 py-4 text-left transition-colors hover:bg-muted/30"
                      onClick={() => setOpenPerson(expanded ? null : person.user.id)}
                      aria-expanded={expanded}
                    >
                      <Avatar person={person.user} size="md" />
                      <span className="flex min-w-0 flex-col">
                        <span className="font-bold text-foreground">{displayName(person.user)}</span>
                        <span className="text-xs text-muted-foreground">
                          {roleLabel(person.user.role)}
                        </span>
                      </span>
                      <span className="ml-auto flex flex-wrap items-center gap-2">
                        {person.blocked_count > 0 ? (
                          <Badge variant="warning">{person.blocked_count} blocked</Badge>
                        ) : null}
                        {person.overdue_count > 0 ? (
                          <Badge variant="danger">{person.overdue_count} overdue</Badge>
                        ) : null}
                        <Badge variant="default">{person.open_count} open</Badge>
                        {person.tracked_seconds > 0 ? (
                          <span className="tabular rounded-md bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">
                            {formatDuration(person.tracked_seconds)} tracked
                          </span>
                        ) : null}
                        <span className="ml-1 flex h-7 w-7 items-center justify-center rounded-full bg-muted/80 text-muted-foreground">
                          {expanded ? (
                            <ChevronDown className="h-4 w-4" aria-hidden />
                          ) : (
                            <ChevronRight className="h-4 w-4" aria-hidden />
                          )}
                        </span>
                      </span>
                    </button>

                    {expanded ? (
                      <ul className="border-t border-border/70 bg-muted/15">
                        {person.tasks.map((task) => (
                          <TaskRow
                            key={task.id}
                            task={task}
                            today={today}
                            onChanged={invalidate}
                            canRemind
                          />
                        ))}
                      </ul>
                    ) : null}
                  </CardContent>
                </Card>
              );
            })}

            {board.data && board.data.unassigned_count > 0 ? (
              <Card className="overflow-hidden border-dashed">
                <CardContent className="p-0">
                  <div className="border-b border-border/60 bg-muted/30 px-5 py-3">
                    <p className="text-sm font-bold">
                      Unassigned · {board.data.unassigned_count}
                    </p>
                  </div>
                  <ul>
                    {board.data.unassigned.map((task) => (
                      <TaskRow
                        key={task.id}
                        task={task}
                        today={today}
                        onChanged={invalidate}
                      />
                    ))}
                  </ul>
                </CardContent>
              </Card>
            ) : null}
          </div>
        )
      ) : tasks.isLoading ? (
        <Spinner label="Loading team tasks" />
      ) : tasks.isError ? (
        <ErrorState
          message={tasks.error instanceof ApiError ? tasks.error.message : "Could not load team tasks."}
          onRetry={() => void tasks.refetch()}
        />
      ) : total === 0 ? (
        <EmptyState
          title="No tasks match"
          description="Adjust the filters, or create the first task for the team."
          action={
            capabilities.can_create_tasks ? (
              <Button className="mt-2" onClick={() => setCreateOpen(true)}>
                Create the first task
              </Button>
            ) : null
          }
        />
      ) : (
        <>
          <Card className="overflow-hidden">
            <ul>
              {(tasks.data?.items ?? []).map((task) => (
                <TaskRow
                  key={task.id}
                  task={task}
                  today={today}
                  onChanged={invalidate}
                  canRemind
                />
              ))}
            </ul>
          </Card>
          <Pager page={page} total={total} pageSize={PAGE_SIZE} onPage={setPage} />
        </>
      )}

      <CreateTaskDialog
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onDone={invalidate}
        showAssignee
      />
    </>
  );
}

export default function TeamTasksPage() {
  return (
    <Suspense fallback={<Spinner />}>
      <TeamTasksInner />
    </Suspense>
  );
}