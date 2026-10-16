"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, CheckCircle2, Clock, FolderKanban, Plus, Search, Sparkles } from "lucide-react";
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
import { todayLocal } from "@/lib/format";
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
      api<TaskList>(`/tasks${qs({ mine: 1, page, page_size: PAGE_SIZE, status, priority, q: query })}`),
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

  const today = todayLocal();
  const items = tasks.data?.items ?? [];
  const total = tasks.data?.total ?? 0;
  const inProgressCount = items.filter((t) => t.status === "in_progress").length;
  const completedCount = items.filter((t) => t.status === "completed").length;
  const overdueCount = items.filter((t) => t.is_overdue).length;

  return (
    <>
      <PageHeader
        title="My Tasks"
        description="Work assigned to you, plus anything you raised for yourself. Work you passed to someone else lives in Team Tasks."
        actions={
          capabilities?.can_create_tasks ? (
            <Button onClick={() => setCreateOpen(true)}>
              <Plus className="h-4 w-4" aria-hidden />
              New Task
            </Button>
          ) : null
        }
      />

      {/* Summary KPI Strip */}
      <div className="mb-5 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <div className="flex items-center justify-between rounded-2xl p-5 hero-green-card shadow-[0_8px_24px_rgba(20,83,56,0.18)]">
          <div>
            <p className="text-xs font-medium text-white/85">Matching Tasks</p>
            <p className="mt-1 tabular text-3xl font-bold text-white">{total}</p>
            <p className="mt-1 text-xs text-[#a9dfc2]">Assigned or raised by you</p>
          </div>
          <span className="flex h-10 w-10 items-center justify-center rounded-2xl bg-white/15 text-white">
            <FolderKanban className="h-5 w-5" aria-hidden />
          </span>
        </div>

        <Card className="flex items-center justify-between p-5">
          <div>
            <p className="text-xs font-medium text-muted-foreground">In Progress (Page)</p>
            <p className="mt-1 tabular text-3xl font-bold text-foreground">{inProgressCount}</p>
            <p className="mt-1 text-xs text-[#1f7a52]">Active workflow items</p>
          </div>
          <span className="flex h-10 w-10 items-center justify-center rounded-2xl bg-[#eaf4ef] text-[#145338]">
            <Clock className="h-5 w-5" aria-hidden />
          </span>
        </Card>

        <Card className="flex items-center justify-between p-5">
          <div>
            <p className="text-xs font-medium text-muted-foreground">Completed (Page)</p>
            <p className="mt-1 tabular text-3xl font-bold text-foreground">{completedCount}</p>
            <p className="mt-1 text-xs text-[#1f7a52]">Finished tasks</p>
          </div>
          <span className="flex h-10 w-10 items-center justify-center rounded-2xl bg-[#eaf4ef] text-[#145338]">
            <CheckCircle2 className="h-5 w-5" aria-hidden />
          </span>
        </Card>

        <Card className="flex items-center justify-between p-5">
          <div>
            <p className="text-xs font-medium text-muted-foreground">Overdue (Page)</p>
            <p
              className={`mt-1 tabular text-3xl font-bold ${
                overdueCount > 0 ? "text-destructive" : "text-foreground"
              }`}
            >
              {overdueCount}
            </p>
            <p className="mt-1 text-xs text-muted-foreground">Past due date</p>
          </div>
          <span
            className={`flex h-10 w-10 items-center justify-center rounded-2xl ${
              overdueCount > 0
                ? "bg-[#fdecee] text-destructive"
                : "bg-[#eaf4ef] text-[#145338]"
            }`}
          >
            <AlertTriangle className="h-5 w-5" aria-hidden />
          </span>
        </Card>
      </div>

      {/* Quick Add Card */}
      {capabilities?.can_create_tasks ? (
        <Card className="mb-4 border-[#145338]/20 bg-[#eaf4ef]/35">
          <CardContent className="flex flex-wrap items-center gap-2.5 p-3.5">
            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-[#145338] text-white">
              <Sparkles className="h-4 w-4" aria-hidden />
            </span>
            <Input
              className="min-w-[220px] flex-1 rounded-full border-border/70 bg-card"
              placeholder="Quick add — e.g. Update competitor sheet"
              value={quickAdd}
              onChange={(e) => setQuickAdd(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && quickAdd.trim()) quickAddMutation.mutate(quickAdd.trim());
              }}
            />
            <Button
              disabled={!quickAdd.trim()}
              loading={quickAddMutation.isPending}
              onClick={() => quickAddMutation.mutate(quickAdd.trim())}
            >
              Add Task
            </Button>
          </CardContent>
        </Card>
      ) : null}

      {/* Filter Bar Card */}
      <Card className="mb-5 p-3.5">
        <div className="flex flex-wrap items-center gap-2.5">
          <div className="relative min-w-[220px] flex-1 max-w-sm">
            <Search
              className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
              aria-hidden
            />
            <Input
              className="h-9 rounded-full bg-[#f7f8f9] pl-9"
              placeholder="Search by title…"
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setPage(1);
              }}
            />
          </div>
          <Select
            className="h-9 w-auto rounded-full px-4"
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
            className="h-9 w-auto rounded-full px-4"
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
          {status || priority || query ? (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setStatus("");
                setPriority("");
                setQuery("");
                setPage(1);
              }}
            >
              Clear
            </Button>
          ) : null}
        </div>
      </Card>

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
          <Card className="overflow-hidden">
            <ul>
              {items.map((task) => (
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
