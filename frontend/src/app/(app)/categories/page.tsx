"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, FolderKanban, Layers, Pencil, Plus, RotateCcw, Sparkles, Tag, Trash2 } from "lucide-react";
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

  const allCategories = categories.data;
  const activeCount = allCategories.filter((c) => c.is_active).length;
  const retiredCount = allCategories.length - activeCount;
  const totalCategorizedTasks = allCategories.reduce((sum, c) => sum + c.task_count, 0);

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

      {/* KPI Summary Cards */}
      <div className="mb-5 grid gap-3.5 sm:grid-cols-3">
        <div className="hero-green-card relative overflow-hidden rounded-2xl p-4 shadow-sm">
          <div className="flex items-start justify-between">
            <div>
              <p className="text-xs font-medium text-white/80">Total Categories</p>
              <p className="tabular mt-1.5 text-2xl font-bold tracking-tight text-white">
                {allCategories.length}
              </p>
            </div>
            <span className="flex h-9 w-9 items-center justify-center rounded-full bg-white/15 text-white">
              <Tag className="h-4 w-4" aria-hidden />
            </span>
          </div>
          <p className="mt-2 text-[11px] font-medium text-white/75">
            {retiredCount > 0 ? `${retiredCount} retired from pickers` : "All categories currently active"}
          </p>
        </div>

        <div className="rounded-2xl border border-border/70 bg-card p-4 shadow-[0_1px_3px_rgba(15,23,42,0.03)]">
          <div className="flex items-start justify-between">
            <div>
              <p className="text-xs font-medium text-muted-foreground">Active in Pickers</p>
              <p className="tabular mt-1.5 text-2xl font-bold tracking-tight text-foreground">
                {activeCount}
              </p>
            </div>
            <span className="flex h-9 w-9 items-center justify-center rounded-full bg-[#eaf4ef] text-[#145338]">
              <CheckCircle2 className="h-4 w-4" aria-hidden />
            </span>
          </div>
          <p className="mt-2 text-[11px] text-muted-foreground">
            Available when creating or editing tasks
          </p>
        </div>

        <div className="rounded-2xl border border-border/70 bg-card p-4 shadow-[0_1px_3px_rgba(15,23,42,0.03)]">
          <div className="flex items-start justify-between">
            <div>
              <p className="text-xs font-medium text-muted-foreground">Tasks Categorized</p>
              <p className="tabular mt-1.5 text-2xl font-bold tracking-tight text-foreground">
                {totalCategorizedTasks}
              </p>
            </div>
            <span className="flex h-9 w-9 items-center justify-center rounded-full bg-[#eaf4ef] text-[#145338]">
              <FolderKanban className="h-4 w-4" aria-hidden />
            </span>
          </div>
          <p className="mt-2 text-[11px] text-muted-foreground">
            Total tasks linked across categories
          </p>
        </div>
      </div>

      {adding ? (
        <div className="mb-4 rounded-2xl border border-[#1f7a52]/20 bg-gradient-to-r from-[#eaf4ef]/60 via-white to-white p-3.5 shadow-[0_1px_3px_rgba(15,23,42,0.03)]">
          <div className="flex flex-wrap items-center gap-2.5">
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-[#145338] text-white shadow-xs">
              <Sparkles className="h-4 w-4" aria-hidden />
            </div>
            <div className="min-w-[200px] flex-1">
              <Input
                autoFocus
                placeholder="New category label — e.g. Paid social"
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && label.trim()) create.mutate();
                }}
                className="border-transparent bg-white/90 shadow-xs focus:border-[#1f7a52]"
              />
            </div>
            <Button
              disabled={!label.trim()}
              loading={create.isPending}
              onClick={() => create.mutate()}
            >
              Add
            </Button>
          </div>
        </div>
      ) : null}

      {allCategories.length === 0 ? (
        <EmptyState title="No categories" description="Add one to get started." />
      ) : (
        <Card className="overflow-hidden">
          <div className="flex items-center justify-between border-b border-border/60 bg-muted/20 px-5 py-3">
            <div className="flex items-center gap-2">
              <Layers className="h-4 w-4 text-[#145338]" aria-hidden />
              <span className="text-xs font-semibold tracking-wider text-muted-foreground uppercase">
                Category Directory ({allCategories.length})
              </span>
            </div>
            <span className="text-xs text-muted-foreground">
              Slugs remain immutable so historical task filters never break
            </span>
          </div>
          <ul className="divide-y divide-border/60">
            {allCategories.map((row) => (
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
      <li className="flex items-center gap-2.5 bg-[#eaf4ef]/30 px-5 py-3.5">
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
    <li className="flex flex-wrap items-center gap-3 px-5 py-3.5 transition-colors hover:bg-muted/25">
      <div
        className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-xl ${
          row.is_active ? "bg-[#eaf4ef] text-[#145338]" : "bg-muted text-muted-foreground"
        }`}
      >
        <Tag className="h-4 w-4" aria-hidden />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span
            className={`text-sm font-semibold ${
              row.is_active ? "text-foreground" : "text-muted-foreground line-through"
            }`}
          >
            {row.label}
          </span>
          <span className="rounded-md bg-muted/70 px-2 py-0.5 font-mono text-[11px] text-muted-foreground">
            {row.slug}
          </span>
          {!row.is_active ? <Badge variant="muted">Retired</Badge> : null}
        </div>
      </div>
      <Badge variant={row.task_count > 0 ? "default" : "muted"}>
        {row.task_count} task{row.task_count === 1 ? "" : "s"}
      </Badge>
      {row.is_active ? (
        <div className="flex items-center gap-1">
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => setEditing(true)}>
            <Pencil className="h-3.5 w-3.5" aria-hidden />
            Rename
          </Button>
          <Button size="sm" variant="ghost" disabled={busy} onClick={onRetire}>
            <Trash2 className="h-3.5 w-3.5 text-destructive" aria-hidden />
            Retire
          </Button>
        </div>
      ) : (
        <Button size="sm" variant="outline" disabled={busy} onClick={onRestore}>
          <RotateCcw className="h-3.5 w-3.5" aria-hidden />
          Restore
        </Button>
      )}
    </li>
  );
}