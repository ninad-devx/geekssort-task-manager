"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { PageHeader } from "@/components/app-shell";
import { TaskRow } from "@/components/tasks/task-ui";
import { Button } from "@/components/ui/button";
import { Card, CardContent, EmptyState, ErrorState, Spinner } from "@/components/ui/card";
import { Input, Select } from "@/components/ui/form";
import { CreateTaskDialog, Pager } from "@/components/tasks/task-dialogs";
import { api, ApiError, qs } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { PRIORITY_LABELS, STATUS_LABELS, type Task, type TaskList } from "@/lib/types";

const PAGE_SIZE = 50;

export default function MyTasksPage() {
  const { capabilities } = useAuth();
  const client = useQueryClient();
  const [page, setPage] = useState(1);
  const [status, setStatus] = useState("");
  const [priority, setPriority] = useState("");
  const [query, setQuery] = useState("");
  const [quickAdd, setQuickAdd] = useState("");
  const [createOpen, setCreateOpen] = useState(false);

  const tasks = useQuery({
    queryKey: ["tasks", "mine", page, status, priority, query],
    queryFn: () =>
      api<TaskList>(`/tasks${qs({ page, page_size: PAGE_SIZE, status, priority, q: query })}`),
  });

  const invalidate = () => client.invalidateQueries({ queryKey: ["tasks"] });

  const quickAddMutation = useMutation({
    mutationFn: (title: string) => api<Task>("/tasks", { method: "POST", json: { title } }),
    onSuccess: async () => {
      setQuickAdd("");
      toast.success("Task added");
      await invalidate();
    },
    onError: (error) =>
      toast.error(error instanceof ApiError ? error.message : "Could not add the task"),
  });

  const today = new Date().toISOString().slice(0, 10);
  const total = tasks.data?.total ?? 0;

  return (
    <>
      <PageHeader
        title="My Tasks"
        description="Everything assigned to you, plus anything you created for yourself."
        actions={
          capabilities?.can_create_tasks ? (
            <Button onClick={() => setCreateOpen(true)}>
              <Plus className="h-4 w-4" aria-hidden />
              New task
            </Button>
          ) : null
        }
      />

      {capabilities?.can_create_tasks ? (
        <Card className="mb-4">
          <CardContent className="flex gap-2 p-3">
            <Input
              placeholder="Quick add — e.g. Update competitor sheet"
              value={quickAdd}
              onChange={(e) => setQuickAdd(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && quickAdd.trim()) quickAddMutation.mutate(quickAdd.trim());
              }}
            />
            <Button
              variant="outline"
              disabled={!quickAdd.trim()}
              loading={quickAddMutation.isPending}
              onClick={() => quickAddMutation.mutate(quickAdd.trim())}
            >
              Add
            </Button>
          </CardContent>
        </Card>
      ) : null}

      <div className="mb-4 flex flex-wrap gap-2">
        <Input
          className="h-9 max-w-xs"
          placeholder="Search by title…"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setPage(1);
          }}
        />
        <Select
          className="h-9 w-auto"
          value={status}
          onChange={(e) => {
            setStatus(e.target.value);
            setPage(1);
          }}
        >
          <option value="">All statuses</option>
          {Object.entries(STATUS_LABELS).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </Select>
        <Select
          className="h-9 w-auto"
          value={priority}
          onChange={(e) => {
            setPriority(e.target.value);
            setPage(1);
          }}
        >
          <option value="">All priorities</option>
          {Object.entries(PRIORITY_LABELS).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </Select>
      </div>

      {tasks.isLoading ? (
        <Spinner label="Loading your tasks" />
      ) : tasks.isError ? (
        <ErrorState
          message={tasks.error instanceof ApiError ? tasks.error.message : "Could not load your tasks."}
          onRetry={() => void tasks.refetch()}
        />
      ) : total === 0 ? (
        <EmptyState
          title="No tasks here"
          description={
            capabilities?.can_create_tasks
              ? "Use Quick add above to capture ad-hoc work, or ask your team lead to assign something."
              : "Nothing is assigned to you right now."
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

      <CreateTaskDialog open={createOpen} onClose={() => setCreateOpen(false)} onDone={invalidate} />
    </>
  );
}
