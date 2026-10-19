"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  CalendarCheck,
  CheckCircle2,
  Clock,
  FolderKanban,
  Plus,
  Search,
  Sparkles,
} from "lucide-react";
import { useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";
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
import { cn } from "@/lib/utils";

const PAGE_SIZE = 50;

/**
 * Which question the list is answering.
 *
 * `today` is the default because that is what people mean when they open their
 * own task list. The old default returned everything ever assigned and sorted by
 * due date, which put a backlog from previous days above today's work -- so the
 * page opened on yesterday and the day's actual work was nowhere in sight.
 */
const SCOPES = [
  { key: "today", label: "Today" },
  { key: "open", label: "Open" },
  { key: "done", label: "Completed" },
  { key: "all", label: "All" },
] as const;

type ScopeKey = (typeof SCOPES)[number]["key"];

const SCOPE_HINTS: Record<ScopeKey, string> = {
  today: "Overdue from earlier days, due today, and whatever is in flight — ordered by what needs you first.",
  open: "Everything still to do, whatever its due date.",
  done: "Everything you have finished.",
  all: "Your entire history, newest first among equal due dates.",
};

const EMPTY_COPY: Record<ScopeKey, { title: string; description: string }> = {
  today: {
    title: "Nothing due today",
    description: "No overdue work, nothing due today, and nothing in progress. Use Quick add if something just came up.",
  },
  open: { title: "Nothing open", description: "Every task assigned to you is finished." },
  done: { title: "Nothing completed yet", description: "Finished tasks will collect here." },
  all: {
    title: "No tasks here",
    description: "Use Quick add above to capture ad-hoc work, or ask your team lead to assign something.",
  },
};

function MyTasksInner() {
  const params = useSearchParams();
  const { capabilities } = useAuth();
  const client = useQueryClient();
  const [page, setPage] = useState(1);
  const [status, setStatus] = useState("");
  const [priority, setPriority] = useState("");
  const [query, setQuery] = useState(params.get("q") ?? "");
  const [quickAdd, setQuickAdd] = useState("");
  const [createOpen, setCreateOpen] = useState(false);

  // Read the requested scope once, on mount. Other screens link in with
  // `?scope=open` and expect to land on that view; from then on the tab strip
  // owns it, so switching tabs never fights the URL or remounts the page.
  const [scope, setScope] = useState<ScopeKey>(() => {
    const requested = params.get("scope");
    return requested === "open" || requested === "done" || requested === "all" ? requested : "today";
  });

  // "All" is the absence of a scope filter, so it is sent as no parameter at
  // all rather than as a value the API would have to special-case.
  const scopeParamValue = scope === "all" ? undefined : scope;

  const tasks = useQuery({
    queryKey: ["tasks", "mine", scope, page, status, priority, query],
    queryFn: () =>
      api<TaskList>(
        `/tasks${qs({
          mine: 1,
          scope: scopeParamValue,
          page,
          page_size: PAGE_SIZE,
          status,
          priority,
          q: query,
        })}`,
      ),
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

  const changeScope = (next: ScopeKey) => {
    setScope(next);
    setPage(1);
  };

  const today = todayLocal();
  const items = tasks.data?.items ?? [];
  const total = tasks.data?.total ?? 0;
  const summary = tasks.data?.summary;
  const inProgressCount = summary?.in_progress ?? items.filter((t) => t.status === "in_progress").length;
  const overdueCount = summary?.overdue ?? items.filter((t) => t.is_overdue).length;
  const dueTodayCount = summary?.due_today ?? 0;
  const doneCount =
    scope === "today" ? (summary?.completed_today ?? 0) : (summary?.by_status.completed ?? 0);

  const heading =
    scope === "today"
      ? "Today"
      : scope === "done"
        ? "Completed"
        : scope === "open"
          ? "Open"
          : "All";

  return (
    <>
      <PageHeader
        title="My Tasks"
        description={SCOPE_HINTS[scope]}
        actions={
          capabilities?.can_create_tasks ? (
            <Button onClick={() => setCreateOpen(true)}>
              <Plus className="h-4 w-4" aria-hidden />
              New Task
            </Button>
          ) : null
        }
      />

      {/* Scope strip. Today first, because that is the question people arrive with. */}
      <div
        role="tablist"
        aria-label="Task scope"
        className="mb-5 inline-flex flex-wrap rounded-full bg-muted p-0.5 text-sm"
      >
        {SCOPES.map((entry) => (
          <button
            key={entry.key}
            type="button"
            role="tab"
            aria-selected={scope === entry.key}
            onClick={() => changeScope(entry.key)}
            className={cn(
              "rounded-full px-4 py-1.5 font-medium transition-colors",
              scope === entry.key
                ? "bg-card text-foreground shadow-2xs"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            {entry.label}
          </button>
        ))}
      </div>

      {/* Summary KPI Strip — counts cover the whole filtered set, not one page. */}
      <div className="mb-5 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <div className="flex items-center justify-between rounded-2xl p-5 hero-green-card shadow-[0_8px_24px_rgba(20,83,56,0.18)]">
          <div>
            <p className="text-xs font-medium text-white/85">{heading} Tasks</p>
            <p className="mt-1 tabular text-3xl font-bold text-white">{total}</p>
            <p className="mt-1 text-xs text-[#a9dfc2]">Assigned or raised by you</p>
          </div>
          <span className="flex h-10 w-10 items-center justify-center rounded-2xl bg-white/15 text-white">
            <FolderKanban className="h-5 w-5" aria-hidden />
          </span>
        </div>

        <Card className="flex items-center justify-between p-5">
          <div>
            <p className="text-xs font-medium text-muted-foreground">In Progress</p>
            <p className="mt-1 tabular text-3xl font-bold text-foreground">{inProgressCount}</p>
            <p className="mt-1 text-xs text-[#1f7a52]">Active workflow items</p>
          </div>
          <span className="flex h-10 w-10 items-center justify-center rounded-2xl bg-[#eaf4ef] text-[#145338]">
            <Clock className="h-5 w-5" aria-hidden />
          </span>
        </Card>

        <Card className="flex items-center justify-between p-5">
          <div>
            <p className="text-xs font-medium text-muted-foreground">
              {scope === "today" ? "Done Today" : "Completed"}
            </p>
            <p className="mt-1 tabular text-3xl font-bold text-foreground">{doneCount}</p>
            <p className="mt-1 text-xs text-[#1f7a52]">
              {scope === "today" ? "Finished today" : "Finished tasks"}
            </p>
          </div>
          <span className="flex h-10 w-10 items-center justify-center rounded-2xl bg-[#eaf4ef] text-[#145338]">
            <CheckCircle2 className="h-5 w-5" aria-hidden />
          </span>
        </Card>

        <Card className="flex items-center justify-between p-5">
          <div>
            <p className="text-xs font-medium text-muted-foreground">Needs Attention</p>
            <p
              className={`mt-1 tabular text-3xl font-bold ${
                overdueCount > 0 ? "text-destructive" : "text-foreground"
              }`}
            >
              {overdueCount + dueTodayCount}
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              {overdueCount} overdue · {dueTodayCount} due today
            </p>
          </div>
          <span
            className={`flex h-10 w-10 items-center justify-center rounded-2xl ${
              overdueCount > 0
                ? "bg-[#fdecee] text-destructive"
                : "bg-[#eaf4ef] text-[#145338]"
            }`}
          >
            {overdueCount > 0 ? (
              <AlertTriangle className="h-5 w-5" aria-hidden />
            ) : (
              <CalendarCheck className="h-5 w-5" aria-hidden />
            )}
          </span>
        </Card>
      </div>

      {/* The today view deliberately leaves old slippage out so the day's real
          work is visible. Say so, and make it one click away -- otherwise a
          small number reads as "the backlog is gone". */}
      {scope === "today" && (summary?.older_overdue ?? 0) > 0 ? (
        <Card className="mb-5 border-[#f97316]/30 bg-[#fff7ed]">
          <CardContent className="flex flex-wrap items-center gap-3 p-3.5 text-sm">
            <AlertTriangle className="h-4 w-4 text-[#b45309]" aria-hidden />
            <span className="min-w-0 flex-1 text-foreground">
              <span className="font-semibold tabular">{summary?.older_overdue}</span> more
              {summary?.older_overdue === 1 ? " task is" : " tasks are"} overdue by more than{" "}
              {summary?.carry_days ?? 7} days. Left off today&rsquo;s board so the day&rsquo;s work
              is visible.
            </span>
            <Button variant="outline" size="sm" onClick={() => changeScope("open")}>
              View all open work
            </Button>
          </CardContent>
        </Card>
      ) : null}

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
          <div className="relative min-w-[220px] max-w-sm flex-1">
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
          {status || priority || query || scope !== "today" ? (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setStatus("");
                setPriority("");
                setQuery("");
                changeScope("today");
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
          message={
            tasks.error instanceof ApiError ? tasks.error.message : "Could not load your tasks."
          }
          onRetry={() => void tasks.refetch()}
        />
      ) : total === 0 ? (
        <EmptyState
          title={EMPTY_COPY[scope].title}
          description={
            !capabilities?.can_create_tasks && scope === "today"
              ? "Nothing is assigned to you right now."
              : EMPTY_COPY[scope].description
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

export default function MyTasksPage() {
  return (
    <Suspense fallback={<Spinner label="Loading your tasks" />}>
      <MyTasksInner />
    </Suspense>
  );
}