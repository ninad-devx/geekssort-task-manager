"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";

import { PageHeader } from "@/components/app-shell";
import { CreateTaskDialog, Pager } from "@/components/tasks/task-dialogs";
import { TaskRow } from "@/components/tasks/task-ui";
import { Button } from "@/components/ui/button";
import { Card, EmptyState, ErrorState, Spinner } from "@/components/ui/card";
import { Input, Select } from "@/components/ui/form";
import { api, ApiError, qs } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import {
  CATEGORY_LABELS,
  PRIORITY_LABELS,
  STATUS_LABELS,
  type DirectoryEntry,
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

  const filters = {
    status: params.get("status") ?? "",
    priority: params.get("priority") ?? "",
    assignee_id: params.get("assignee_id") ?? "",
    category: params.get("category") ?? "",
    overdue: params.get("overdue") ?? "",
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

  const invalidate = () => client.invalidateQueries({ queryKey: ["tasks"] });
  const today = new Date().toISOString().slice(0, 10);
  const total = tasks.data?.total ?? 0;

  return (
    <>
      <PageHeader
        title="Team Tasks"
        description="Every task in the company, including deleted ones when you switch that on."
        actions={
          <>
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
        <Button variant="ghost" size="sm" onClick={() => router.replace("/team-tasks")}>
          Clear
        </Button>
      </div>

      {tasks.isLoading ? (
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
                <TaskRow key={task.id} task={task} today={today} onChanged={invalidate} />
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