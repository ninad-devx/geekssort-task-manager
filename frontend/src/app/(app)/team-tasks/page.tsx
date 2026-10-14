"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronDown, ChevronRight, Plus } from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";

import { PageHeader, roleLabel } from "@/components/app-shell";
import { Avatar, displayName } from "@/components/avatar";
import { CreateTaskDialog, Pager } from "@/components/tasks/task-dialogs";
import { TaskRow } from "@/components/tasks/task-ui";
import { Button } from "@/components/ui/button";
import { Card, CardContent, EmptyState, ErrorState, Spinner } from "@/components/ui/card";
import { Badge, Input, Select } from "@/components/ui/form";
import { api, ApiError, qs } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { formatDuration } from "@/lib/format";
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
  const [showDeleted, setShowDeleted] = useState(false);
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

  const tasks = useQuery({
    queryKey: ["tasks", "team", page, filters, showDeleted],
    queryFn: () =>
      api<TaskList>(
        `/tasks${qs({ ...filters, page, page_size: PAGE_SIZE, include_deleted: showDeleted })}`,
      ),
    enabled: view === "list",
  });

  const board = useQuery({
    queryKey: ["tasks", "board", filters.status, filters.q, filters.completed_from, filters.completed_to],
    queryFn: () =>
      api<TaskBoard>(
        `/tasks/board${qs({
          status: filters.status,
          q: filters.q,
          completed_from: filters.completed_from,
          completed_to: filters.completed_to,
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
  const today = new Date().toISOString().slice(0, 10);
  const total = tasks.data?.total ?? 0;

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
            <Button variant="outline" onClick={() => setShowDeleted((v) => !v)}>
              {showDeleted ? "Hide deleted" : "Show deleted"}
            </Button>
            {capabilities.can_create_tasks ? (
              <Button onClick={() => setCreateOpen(true)}>
                <Plus className="h-4 w-4" aria-hidden />
                New task
              </Button>
            ) : null}
          </>
        }
      />

      <div className="mb-4 flex flex-wrap gap-2">
        <Input
          className="h-9 max-w-xs"
          placeholder="Search by title…"
          value={filters.q}
          onChange={(e) => setFilter("q", e.target.value)}
        />
        <Select className="h-9 w-auto" value={filters.status} onChange={(e) => setFilter("status", e.target.value)}>
          <option value="">All statuses</option>
          {Object.entries(STATUS_LABELS).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </Select>
        <Select className="h-9 w-auto" value={filters.priority} onChange={(e) => setFilter("priority", e.target.value)}>
          <option value="">All priorities</option>
          {Object.entries(PRIORITY_LABELS).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </Select>
        <Select
          className="h-9 w-auto"
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
        <Select className="h-9 w-auto" value={filters.category} onChange={(e) => setFilter("category", e.target.value)}>
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
        ) : (board.data?.people.length ?? 0) === 0 && board.data?.unassigned_count === 0 ? (
          <EmptyState
            title="Nothing assigned right now"
            description="When work is assigned it appears here, grouped by person."
          />
        ) : (
          <div className="space-y-2">
            {(board.data?.people ?? []).map((person) => {
              const expanded = openPerson === person.user.id;
              return (
                <Card key={person.user.id}>
                  <CardContent className="py-3">
                    <button
                      type="button"
                      className="flex w-full flex-wrap items-center gap-3 text-left"
                      onClick={() => setOpenPerson(expanded ? null : person.user.id)}
                      aria-expanded={expanded}
                    >
                      <Avatar person={person.user} size="md" />
                      <span className="flex min-w-0 flex-col">
                        <span className="font-medium">{displayName(person.user)}</span>
                        <span className="text-xs text-muted-foreground">
                          {roleLabel(person.user.role)}
                        </span>
                      </span>
                      <span className="ml-auto flex flex-wrap items-center gap-2">
                        {person.blocked_count > 0 ? (
                          <Badge variant="warning">{person.blocked_count} blocked</Badge>
                        ) : null}
                        {person.overdue_count > 0 ? (
                          <Badge variant="warning">{person.overdue_count} overdue</Badge>
                        ) : null}
                        <Badge variant="outline">
                          {person.open_count} open
                        </Badge>
                        {person.tracked_seconds > 0 ? (
                          <span className="tabular text-xs text-muted-foreground">
                            {formatDuration(person.tracked_seconds)} tracked
                          </span>
                        ) : null}
                        {expanded ? (
                          <ChevronDown className="h-4 w-4" aria-hidden />
                        ) : (
                          <ChevronRight className="h-4 w-4" aria-hidden />
                        )}
                      </span>
                    </button>

                    {expanded ? (
                      <ul className="mt-3 border-l-2 border-border pl-3">
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
              <Card className="border-dashed">
                <CardContent className="py-3">
                  <p className="text-sm font-medium">
                    Unassigned · {board.data.unassigned_count}
                  </p>
                  <ul className="mt-2">
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
          <Card>
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