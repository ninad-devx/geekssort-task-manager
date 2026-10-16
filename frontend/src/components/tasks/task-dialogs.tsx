"use client";

import { useMutation, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Dialog, Field, Input, Select } from "@/components/ui/form";
import { api, errorMessage } from "@/lib/api";
import {
  CATEGORY_LABELS,
  PRIORITY_LABELS,
  type DirectoryEntry,
  type Task,
} from "@/lib/types";

export function Pager({
  page,
  total,
  pageSize,
  onPage,
}: {
  page: number;
  total: number;
  pageSize: number;
  onPage: (page: number) => void;
}) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  if (pages <= 1) return null;
  // Page numbers past the end render an empty list with no explanation, because
  // the parent only clamped on some pages. Callers clamp; this is the backstop.
  if (page > pages) return null;
  return (
    <div className="mt-4 flex items-center justify-between text-sm">
      <span className="text-muted-foreground">
        Page {page} of {pages} · {total} in total
      </span>
      <div className="flex gap-2">
        <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => onPage(page - 1)}>
          Previous
        </Button>
        <Button variant="outline" size="sm" disabled={page >= pages} onClick={() => onPage(page + 1)}>
          Next
        </Button>
      </div>
    </div>
  );
}

export function CreateTaskDialog({
  open,
  onClose,
  onDone,
  defaultAssignee,
  lockAssignee,
  showAssignee,
}: {
  open: boolean;
  onClose: () => void;
  onDone: () => void;
  defaultAssignee?: number;
  lockAssignee?: boolean;
  showAssignee?: boolean;
}) {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [priority, setPriority] = useState("medium");
  const [category, setCategory] = useState("");
  const [dueDate, setDueDate] = useState("");
  const [assigneeId, setAssigneeId] = useState("");
  const [requiresReview, setRequiresReview] = useState(false);
  const [touched, setTouched] = useState(false);

  const directory = useQuery({
    queryKey: ["directory"],
    queryFn: () => api<DirectoryEntry[]>("/users/directory"),
    enabled: open,
  });

  const mutation = useMutation({
    mutationFn: () =>
      api<Task>("/tasks", {
        method: "POST",
        json: {
          title: title.trim(),
          description: description || null,
          priority,
          category: category || null,
          due_date: dueDate || null,
          requires_review: requiresReview,
          assignee_id: showAssignee && assigneeId ? Number(assigneeId) : (defaultAssignee ?? null),
        },
      }),
    onSuccess: async () => {
      toast.success("Task created");
      reset();
      onClose();
      await onDone();
    },
    onError: (error) => toast.error(errorMessage(error)),
  });

  // Every field. The old version cleared only title, description, due date and
  // category, so a task created for Alice with review required and a non-default
  // priority silently pre-filled the *next* one the same way with no indication.
  const reset = () => {
    setTitle("");
    setDescription("");
    setDueDate("");
    setCategory("");
    setPriority("medium");
    setAssigneeId("");
    setRequiresReview(false);
    setTouched(false);
  };

  const showTitleError = touched && title.trim().length === 0;

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Create a task"
      onSubmit={() => {
        setTouched(true);
        if (title.trim()) mutation.mutate();
      }}
      submitLabel="Create"
      submitting={mutation.isPending}
    >
      <div className="flex flex-col gap-4">
        <Field label="Title" required error={showTitleError ? "Give the task a title" : undefined}>
          <Input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            maxLength={200}
            required
            placeholder="What needs doing?"
          />
        </Field>
        <Field label="Description" hint="Optional">
          <Input
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            maxLength={5000}
          />
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Priority">
            <Select value={priority} onChange={(e) => setPriority(e.target.value)}>
              {Object.entries(PRIORITY_LABELS).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Category">
            <Select value={category} onChange={(e) => setCategory(e.target.value)}>
              <option value="">None</option>
              {Object.entries(CATEGORY_LABELS).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Due date" hint="Optional">
            <Input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
          </Field>
          {showAssignee ? (
            <Field
              label="Assignee"
              hint={lockAssignee ? "Members may only assign tasks to themselves." : undefined}
            >
              <Select value={assigneeId} disabled={lockAssignee} onChange={(e) => setAssigneeId(e.target.value)}>
                <option value="">Unassigned</option>
                {(directory.data ?? [])
                  .filter((entry) => entry.is_active)
                  .map((entry) => (
                    <option key={entry.id} value={entry.id}>
                      {entry.full_name}
                    </option>
                  ))}
              </Select>
            </Field>
          ) : null}
        </div>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={requiresReview}
            onChange={(e) => setRequiresReview(e.target.checked)}
          />
          Requires review before it can be completed
        </label>
      </div>
    </Dialog>
  );
}
