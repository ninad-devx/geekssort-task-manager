"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { RotateCcw, ShieldCheck } from "lucide-react";
import { toast } from "sonner";

import { PageHeader, roleLabel } from "@/components/app-shell";
import { Button } from "@/components/ui/button";
import { Card, CardContent, ErrorState, Spinner } from "@/components/ui/card";
import { Badge } from "@/components/ui/form";
import { api, ApiError } from "@/lib/api";
import { useAuth } from "@/lib/auth";

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
      // Your own powers may have just changed, so refresh the session.
      await client.invalidateQueries({ queryKey: ["me"] });
    },
    onError: (error) =>
      toast.error(error instanceof ApiError ? error.message : "Could not save permissions"),
  });

  const reset = useMutation({
    mutationFn: (role: string) => api<RolePermissions>(`/permissions/${role}`, { method: "DELETE" }),
    onSuccess: async (row) => {
      toast.success(`${roleLabel(row.role)} reset to defaults`);
      await client.invalidateQueries({ queryKey: ["permissions"] });
      await client.invalidateQueries({ queryKey: ["me"] });
    },
    onError: (error) =>
      toast.error(error instanceof ApiError ? error.message : "Could not reset permissions"),
  });

  if (!capabilities?.can_manage_users) {
    return (
      <ErrorState message="You do not have access to role permissions." />
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

  return (
    <>
      <PageHeader
        title="Role permissions"
        description="What each role may do. Changes apply to everyone on the next request, and are recorded in the audit log."
      />

      <div className="space-y-6">
        {matrix.data.roles.map((role) => {
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
            <Card key={role.role}>
              <CardContent>
                <div className="mb-3 flex flex-wrap items-center gap-2">
                  <ShieldCheck className="h-4 w-4 text-primary" aria-hidden />
                  <h2 className="text-base font-semibold">{roleLabel(role.role)}</h2>
                  {role.is_default ? (
                    <Badge variant="outline">defaults</Badge>
                  ) : (
                    <Badge>customised</Badge>
                  )}
                  {changed ? (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="ml-auto"
                      disabled={reset.isPending}
                      onClick={() => reset.mutate(role.role)}
                    >
                      <RotateCcw className="h-4 w-4" aria-hidden />
                      Reset to defaults
                    </Button>
                  ) : null}
                </div>

                <ul className="grid gap-1">
                  {matrix.data.permissions.map((perm) => (
                    <li key={perm.key}>
                      <label className="flex cursor-pointer items-start gap-3 rounded-md px-2 py-1.5 hover:bg-muted">
                        <input
                          type="checkbox"
                          className="mt-0.5"
                          checked={granted.has(perm.key)}
                          disabled={save.isPending}
                          onChange={() => toggle(perm.key)}
                        />
                        <span className="text-sm">
                          {perm.label}
                          {defaults.has(perm.key) ? (
                            <span className="ml-2 text-xs text-muted-foreground">default</span>
                          ) : null}
                        </span>
                      </label>
                    </li>
                  ))}
                </ul>
              </CardContent>
            </Card>
          );
        })}
      </div>
    </>
  );
}