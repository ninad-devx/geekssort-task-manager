"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, KeyRound, Lock, RotateCcw, ShieldCheck } from "lucide-react";
import { toast } from "sonner";

import { PageHeader, roleLabel } from "@/components/app-shell";
import { Button } from "@/components/ui/button";
import { Card, CardContent, EmptyState, ErrorState, Spinner } from "@/components/ui/card";
import { Badge } from "@/components/ui/form";
import { api, ApiError, errorMessage } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { formatDateTime } from "@/lib/format";

interface PermissionInfo {
  key: string;
  label: string;
}

interface RolePermissions {
  role: "ceo" | "team_lead" | "member";
  permissions: string[];
  defaults: string[];
  is_default: boolean;
  updated_at: string | null;
}

interface Matrix {
  permissions: PermissionInfo[];
  roles: RolePermissions[];
}

export default function PermissionsPage() {
  const { capabilities } = useAuth();
  const client = useQueryClient();

  const matrix = useQuery({
    queryKey: ["permissions"],
    queryFn: () => api<Matrix>("/permissions"),
    enabled: !!capabilities?.can_manage_users,
  });

  const save = useMutation({
    mutationFn: (input: { role: string; permissions: string[] }) =>
      api<RolePermissions>(`/permissions/${input.role}`, {
        method: "PUT",
        json: { permissions: input.permissions },
      }),
    onSuccess: async (row) => {
      toast.success(`${roleLabel(row.role)} permissions saved`);
      await client.invalidateQueries({ queryKey: ["permissions"] });
      // Your own powers may have just changed. This used to invalidate
      // `["me"]`, a key that exists nowhere in the app -- the session lives at
      // `["session"]`, so an admin who removed their own rights kept them in
      // the cache, and in the nav, until a hard reload.
      await client.invalidateQueries({ queryKey: ["session"] });
    },
    onError: (error) => toast.error(errorMessage(error)),
  });

  const reset = useMutation({
    mutationFn: (role: string) => api<RolePermissions>(`/permissions/${role}`, { method: "DELETE" }),
    onSuccess: async (row) => {
      toast.success(`${roleLabel(row.role)} reset to defaults`);
      await client.invalidateQueries({ queryKey: ["permissions"] });
      await client.invalidateQueries({ queryKey: ["session"] });
    },
    onError: (error) => toast.error(errorMessage(error)),
  });

  // A refusal is not a malfunction. Rendering it as "Something went wrong" in
  // red, with no retry, made a correct decision look like a bug.
  if (!capabilities?.can_manage_users) {
    return (
      <EmptyState
        title="Role permissions are managed by an administrator"
        description="Ask an admin if you need a role's powers changed."
      />
    );
  }

  if (matrix.isLoading) return <Spinner label="Loading permissions" />;
  if (matrix.isError || !matrix.data) {
    return (
      <ErrorState
        message={
          matrix.error instanceof ApiError ? matrix.error.message : "Could not load permissions."
        }
        onRetry={() => void matrix.refetch()}
      />
    );
  }

  const roles = matrix.data.roles;
  const totalCapabilities = matrix.data.permissions.length;
  const customizedRolesCount = roles.filter((r) => !r.is_default).length;

  return (
    <>
      <PageHeader
        title="Role permissions"
        description="What each role may do. Changes apply to everyone on the next request, and are recorded in the audit log."
      />

      {/* KPI Summary Cards */}
      <div className="mb-5 grid gap-3.5 sm:grid-cols-3">
        <div className="hero-green-card relative overflow-hidden rounded-2xl p-4 shadow-sm">
          <div className="flex items-start justify-between">
            <div>
              <p className="text-xs font-medium text-white/80">Configured Roles</p>
              <p className="tabular mt-1.5 text-2xl font-bold tracking-tight text-white">
                {roles.length}
              </p>
            </div>
            <span className="flex h-9 w-9 items-center justify-center rounded-full bg-white/15 text-white">
              <ShieldCheck className="h-4 w-4" aria-hidden />
            </span>
          </div>
          <p className="mt-2 text-[11px] font-medium text-white/75">
            CEO, Team Lead & Member access tiers
          </p>
        </div>

        <div className="rounded-2xl border border-border/70 bg-card p-4 shadow-[0_1px_3px_rgba(15,23,42,0.03)]">
          <div className="flex items-start justify-between">
            <div>
              <p className="text-xs font-medium text-muted-foreground">Granular Capabilities</p>
              <p className="tabular mt-1.5 text-2xl font-bold tracking-tight text-foreground">
                {totalCapabilities}
              </p>
            </div>
            <span className="flex h-9 w-9 items-center justify-center rounded-full bg-[#eaf4ef] text-[#145338]">
              <KeyRound className="h-4 w-4" aria-hidden />
            </span>
          </div>
          <p className="mt-2 text-[11px] text-muted-foreground">
            Enforced across API endpoints & UI controls
          </p>
        </div>

        <div className="rounded-2xl border border-border/70 bg-card p-4 shadow-[0_1px_3px_rgba(15,23,42,0.03)]">
          <div className="flex items-start justify-between">
            <div>
              <p className="text-xs font-medium text-muted-foreground">Custom Overrides</p>
              <p className="tabular mt-1.5 text-2xl font-bold tracking-tight text-foreground">
                {customizedRolesCount}
              </p>
            </div>
            <span className="flex h-9 w-9 items-center justify-center rounded-full bg-[#eaf4ef] text-[#145338]">
              {customizedRolesCount > 0 ? (
                <Lock className="h-4 w-4" aria-hidden />
              ) : (
                <CheckCircle2 className="h-4 w-4" aria-hidden />
              )}
            </span>
          </div>
          <p className="mt-2 text-[11px] text-muted-foreground">
            {customizedRolesCount > 0
              ? `${customizedRolesCount} role(s) modified from factory defaults`
              : "All roles using default policy"}
          </p>
        </div>
      </div>

      <div className="grid gap-5 xl:grid-cols-3">
        {roles.map((role) => {
          const granted = new Set(role.permissions);
          const defaults = new Set(role.defaults);
          const changed = role.permissions.join() !== role.defaults.join();

          const toggle = (key: string) => {
            const next = new Set(granted);
            if (next.has(key)) next.delete(key);
            else next.add(key);
            save.mutate({ role: role.role, permissions: [...next] });
          };

          return (
            <Card key={role.role} className="flex flex-col overflow-hidden">
              <div className="flex flex-wrap items-center gap-2.5 border-b border-border/60 bg-muted/20 px-5 py-4">
                <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-[#eaf4ef] text-[#145338]">
                  <ShieldCheck className="h-4 w-4" aria-hidden />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <h2 className="text-base font-bold tracking-tight">{roleLabel(role.role)}</h2>
                    {role.is_default ? (
                      <Badge variant="outline">defaults</Badge>
                    ) : (
                      <Badge>customised</Badge>
                    )}
                  </div>
                  <p className="text-xs text-muted-foreground">
                    {granted.size} of {totalCapabilities} capabilities granted
                    {role.updated_at ? ` · Updated ${formatDateTime(role.updated_at)}` : ""}
                  </p>
                </div>
                {changed ? (
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={reset.isPending}
                    onClick={() => reset.mutate(role.role)}
                  >
                    <RotateCcw className="h-3.5 w-3.5" aria-hidden />
                    Reset
                  </Button>
                ) : null}
              </div>

              <CardContent className="flex-1 pt-3">
                <ul className="grid gap-1.5">
                  {matrix.data.permissions.map((perm) => {
                    const isChecked = granted.has(perm.key);
                    const isDefault = defaults.has(perm.key);
                    return (
                      <li key={perm.key}>
                        <label
                          className={`flex cursor-pointer items-start gap-3 rounded-xl border px-3 py-2.5 transition-colors ${
                            isChecked
                              ? "border-[#1f7a52]/25 bg-[#eaf4ef]/45"
                              : "border-transparent hover:bg-muted/60"
                          }`}
                        >
                          <input
                            type="checkbox"
                            className="mt-0.5 h-4 w-4 rounded accent-[#145338]"
                            checked={isChecked}
                            disabled={save.isPending}
                            onChange={() => toggle(perm.key)}
                          />
                          <span className="flex-1 text-sm font-medium text-foreground">
                            {perm.label}
                            {isDefault ? (
                              <span className="ml-2 rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
                                default
                              </span>
                            ) : null}
                          </span>
                        </label>
                      </li>
                    );
                  })}
                </ul>
              </CardContent>
            </Card>
          );
        })}
      </div>
    </>
  );
}