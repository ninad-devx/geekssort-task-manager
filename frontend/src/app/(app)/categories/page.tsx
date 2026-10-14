"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, RotateCcw, Trash2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { PageHeader } from "@/components/app-shell";
import { Button } from "@/components/ui/button";
import { Card, EmptyState, ErrorState, Spinner } from "@/components/ui/card";
import { Badge, ConfirmDialog, Input } from "@/components/ui/form";
import { api, ApiError } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import type { Category } from "@/lib/types";

export default function CategoriesPage() {
  const { capabilities } = useAuth();
  const client = useQueryClient();
  const [adding, setAdding] = useState(false);
  const [label, setLabel] = useState("");
  const [retiring, setRetiring] = useState<Category | null>(null);

  const categories = useQuery({
    queryKey: ["categories"],
    queryFn: () => api<Category[]>("/categories"),
    enabled: !!capabilities?.can_manage_users,
  });

  const invalidate = () => client.invalidateQueries({ queryKey: ["categories"] });

  const create = useMutation({
    mutationFn: () =>
      api<Category>("/categories", { method: "POST", json: { label: label.trim() } }),
    onSuccess: async (row) => {
      toast.success(`Category “${row.label}” added`);
      setLabel("");
      setAdding(false);
      await invalidate();
    },
    onError: (error) =>
      toast.error(error instanceof ApiError ? error.message : "Could not add the category"),
  });

  const rename = useMutation({
    mutationFn: (input: { slug: string; label: string }) =>
      api<Category>(`/categories/${input.slug}`, {
        method: "PATCH",
        json: { label: input.label },
      }),
    onSuccess: async () => {
      toast.success("Category renamed");
      await invalidate();
    },
    onError: (error) =>
      toast.error(error instanceof ApiError ? error.message : "Could not rename the category"),
  });

  const retire = useMutation({
    mutationFn: (slug: string) => api<Category>(`/categories/${slug}`, { method: "DELETE" }),
    onSuccess: async (row) => {
      toast.success(`“${row.label}” retired — existing tasks keep it`);
      setRetiring(null);
      await invalidate();
    },
    onError: (error) => {
      toast.error(error instanceof ApiError ? error.message : "Could not retire the category");
      setRetiring(null);
    },
  });

  const restore = useMutation({
    mutationFn: (row: Category) =>
      api<Category>(`/categories/${row.slug}`, {
        method: "PATCH",
        json: { is_active: true },
      }),
    onSuccess: async (row) => {
      toast.success(`“${row.label}” restored`);
      await invalidate();
    },
    onError: (error) =>
      toast.error(error instanceof ApiError ? error.message : "Could not restore the category"),
  });

  if (!capabilities?.can_manage_users) {
    return <ErrorState message="You do not have access to categories." />;
  }
  if (categories.isLoading) return <Spinner label="Loading categories" />;
  if (categories.isError || !categories.data) {
    return (
      <ErrorState
        message={
          categories.error instanceof ApiError
            ? categories.error.message
            : "Could not load categories."
        }
        onRetry={() => void categories.refetch()}
      />
    );
  }

  return (
    <>
      <PageHeader
        title="Categories"
        description="Renaming is safe — tasks store the category, not the wording. Retiring hides a category from the pickers but leaves existing tasks readable."
        actions={
          <Button onClick={() => setAdding((v) => !v)}>
            <Plus className="h-4 w-4" aria-hidden />
            Add category
          </Button>
        }
      />

      {adding ? (
        <Card className="mb-4">
          <div className="flex gap-2 p-3">
            <Input
              autoFocus
              placeholder="e.g. Paid social"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && label.trim()) create.mutate();
              }}
            />
            <Button
              disabled={!label.trim()}
              loading={create.isPending}
              onClick={() => create.mutate()}
            >
              Add
            </Button>
          </div>
        </Card>
      ) : null}

      {categories.data.length === 0 ? (
        <EmptyState title="No categories" description="Add one to get started." />
      ) : (
        <Card>
          <ul>
            {categories.data.map((row) => (
              <CategoryRow
                key={row.slug}
                row={row}
                busy={rename.isPending || retire.isPending || restore.isPending}
                onRename={(next) => rename.mutate({ slug: row.slug, label: next })}
                onRetire={() => setRetiring(row)}
                onRestore={() => restore.mutate(row)}
              />
            ))}
          </ul>
        </Card>
      )}

      <ConfirmDialog
        open={retiring !== null}
        onClose={() => setRetiring(null)}
        confirmLabel="Retire"
        title={`Retire “${retiring?.label ?? ""}”?`}
        description={
          retiring && retiring.task_count > 0
            ? `${retiring.task_count} task(s) still use this category. They keep it, but nobody can pick it for new work.`
            : "It disappears from the category pickers. Nothing is deleted."
        }
        loading={retire.isPending}
        onConfirm={() => retiring && retire.mutate(retiring.slug)}
      />
    </>
  );
}

function CategoryRow({
  row,
  busy,
  onRename,
  onRetire,
  onRestore,
}: {
  row: Category;
  busy: boolean;
  onRename: (label: string) => void;
  onRetire: () => void;
  onRestore: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(row.label);

  if (editing) {
    return (
      <li className="flex items-center gap-2 border-b border-border px-4 py-3 last:border-b-0">
        <Input
          autoFocus
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && value.trim()) {
              onRename(value.trim());
              setEditing(false);
            }
            if (e.key === "Escape") setEditing(false);
          }}
        />
        <Button
          size="sm"
          disabled={!value.trim() || busy}
          onClick={() => {
            onRename(value.trim());
            setEditing(false);
          }}
        >
          Save
        </Button>
        <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>
          Cancel
        </Button>
      </li>
    );
  }

  return (
    <li className="flex items-center gap-3 border-b border-border px-4 py-3 last:border-b-0">
      <span className="min-w-0 flex-1">
        <span className={row.is_active ? "" : "text-muted-foreground line-through"}>
          {row.label}
        </span>
        <span className="ml-2 text-xs text-muted-foreground">{row.slug}</span>
      </span>
      <Badge variant="muted">
        {row.task_count} task{row.task_count === 1 ? "" : "s"}
      </Badge>
      {row.is_active ? (
        <>
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => setEditing(true)}>
            Rename
          </Button>
          <Button size="sm" variant="ghost" disabled={busy} onClick={onRetire}>
            <Trash2 className="h-4 w-4" aria-hidden />
            Retire
          </Button>
        </>
      ) : (
        <Button size="sm" variant="ghost" disabled={busy} onClick={onRestore}>
          <RotateCcw className="h-4 w-4" aria-hidden />
          Restore
        </Button>
      )}
    </li>
  );
}