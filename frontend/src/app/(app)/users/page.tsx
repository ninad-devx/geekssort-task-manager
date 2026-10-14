"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { KeyRound, Plus, UserMinus } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { PageHeader, roleLabel } from "@/components/app-shell";
import { Button } from "@/components/ui/button";
import { Card, CardContent, EmptyState, ErrorState, Spinner } from "@/components/ui/card";
import {
  Badge,
  ConfirmDialog,
  Dialog,
  Field,
  Input,
  Select,
} from "@/components/ui/form";
import { api, ApiError } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import type { CreatedUser, DirectoryEntry, Role, User } from "@/lib/types";

export default function UsersPage() {
  const { capabilities, user: me } = useAuth();
  const client = useQueryClient();
  const [createOpen, setCreateOpen] = useState(false);
  const [resetting, setResetting] = useState<User | null>(null);
  const [deactivating, setDeactivating] = useState<User | null>(null);
  const [issued, setIssued] = useState<{ name: string; password: string | null } | null>(null);

  const users = useQuery({
    queryKey: ["users"],
    queryFn: () => api<User[]>("/users"),
    enabled: !!capabilities?.can_manage_users,
  });

  const directory = useQuery({
    queryKey: ["directory"],
    queryFn: () => api<DirectoryEntry[]>("/users/directory"),
  });

  const invalidate = () => client.invalidateQueries();

  const toggleActive = useMutation({
    mutationFn: (target: User) =>
      api<User>(`/users/${target.id}`, {
        method: "PATCH",
        json: { is_active: !target.is_active },
      }),
    onSuccess: async (updated) => {
      toast.success(updated.is_active ? "User reactivated" : "User deactivated");
      setDeactivating(null);
      await invalidate();
    },
    onError: (error) => {
      toast.error(error instanceof ApiError ? error.message : "Could not update the user");
      setDeactivating(null);
    },
  });

  const resetPassword = useMutation({
    mutationFn: (target: User) =>
      api<CreatedUser>(`/users/${target.id}/reset-password`, { method: "POST", json: {} }),
    onSuccess: async (result) => {
      setIssued({ name: result.full_name, password: result.temporary_password });
      setResetting(null);
      await invalidate();
    },
    onError: (error) =>
      toast.error(error instanceof ApiError ? error.message : "Could not reset the password"),
  });

  if (!capabilities?.can_manage_users) {
    return (
      <EmptyState
        title="Not available"
        description="User management is restricted to administrators."
      />
    );
  }

  return (
    <>
      <PageHeader
        title="Users"
        description="Accounts, roles and flags. People are deactivated, never deleted, so history keeps their name."
        actions={
          <Button onClick={() => setCreateOpen(true)}>
            <Plus className="h-4 w-4" aria-hidden />
            New user
          </Button>
        }
      />

      {users.isLoading ? (
        <Spinner label="Loading users" />
      ) : users.isError ? (
        <ErrorState
          message={users.error instanceof ApiError ? users.error.message : "Could not load users."}
          onRetry={() => void users.refetch()}
        />
      ) : (
        <Card>
          <CardContent className="p-0">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-left text-xs text-muted-foreground">
                  <th className="px-4 py-3 font-medium">Name</th>
                  <th className="px-4 py-3 font-medium">Email</th>
                  <th className="px-4 py-3 font-medium">Role</th>
                  <th className="px-4 py-3 font-medium">Flags</th>
                  <th className="px-4 py-3 font-medium">Status</th>
                  <th className="px-4 py-3" />
                </tr>
              </thead>
              <tbody>
                {users.data!.map((row) => (
                  <tr key={row.id} className="border-b border-border last:border-b-0">
                    <td className="px-4 py-3 font-medium">
                      {row.full_name}
                      {row.id === me?.id ? (
                        <span className="ml-2 text-xs text-muted-foreground">(you)</span>
                      ) : null}
                    </td>
                    <td className="px-4 py-3 text-muted-foreground">{row.email}</td>
                    <td className="px-4 py-3">
                      <RoleSelect user={row} onDone={invalidate} />
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex flex-wrap gap-1">
                        {row.is_admin ? <Badge variant="default">admin</Badge> : null}
                        {row.can_review ? <Badge variant="outline">can review</Badge> : null}
                        {!row.is_admin ? (
                          <FlagToggle user={row} field="is_admin" onDone={invalidate} />
                        ) : null}
                        <FlagToggle user={row} field="can_review" onDone={invalidate} />
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      {row.is_active ? (
                        <Badge variant="success">Active</Badge>
                      ) : (
                        <Badge variant="muted">Inactive</Badge>
                      )}
                      {row.must_change_password ? (
                        <Badge variant="warning" className="ml-1">
                          Must change password
                        </Badge>
                      ) : null}
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex justify-end gap-1">
                        <Button variant="ghost" size="sm" onClick={() => setResetting(row)}>
                          <KeyRound className="h-4 w-4" aria-hidden />
                          Reset
                        </Button>
                        {row.id !== me?.id ? (
                          row.is_active ? (
                            <Button variant="ghost" size="sm" onClick={() => setDeactivating(row)}>
                              <UserMinus className="h-4 w-4" aria-hidden />
                              Deactivate
                            </Button>
                          ) : (
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => toggleActive.mutate(row)}
                              loading={toggleActive.isPending}
                            >
                              Reactivate
                            </Button>
                          )
                        ) : null}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </CardContent>
        </Card>
      )}

      <CreateUserDialog
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onDone={invalidate}
        onIssued={(name, password) => setIssued({ name, password })}
      />

      <ConfirmDialog
        open={resetting !== null}
        onClose={() => setResetting(null)}
        confirmLabel="Reset password"
        title={`Reset the password for ${resetting?.full_name ?? ""}?`}
        description="All their sessions end immediately and they must choose a new password at next sign-in."
        loading={resetPassword.isPending}
        onConfirm={() => resetting && resetPassword.mutate(resetting)}
      />

      <DeactivateDialog
        user={deactivating}
        directory={(directory.data ?? []).filter((d) => d.is_active)}
        onClose={() => setDeactivating(null)}
        onConfirm={(reassignTo) => {
          if (!deactivating) return;
          api(`/users/${deactivating.id}/deactivate`, {
            method: "POST",
            json: { reassign_to_user_id: reassignTo },
          })
            .then(async () => {
              toast.success("User deactivated");
              setDeactivating(null);
              await invalidate();
            })
            .catch((error) => {
              toast.error(
                error instanceof ApiError
                  ? `${error.message}${error.detail.open_task_count ? ` (${error.detail.open_task_count} open tasks)` : ""}`
                  : "Could not deactivate",
              );
            });
        }}
      />

      <IssuedPasswordDialog issued={issued} onClose={() => setIssued(null)} />
    </>
  );
}

function RoleSelect({ user, onDone }: { user: User; onDone: () => void }) {
  const mutation = useMutation({
    mutationFn: (role: Role) => api(`/users/${user.id}`, { method: "PATCH", json: { role } }),
    onSuccess: async () => {
      toast.success("Role updated");
      await onDone();
    },
    onError: (error) =>
      toast.error(error instanceof ApiError ? error.message : "Could not change the role"),
  });

  return (
    <Select
      className="h-8 w-auto text-xs"
      value={user.role}
      disabled={mutation.isPending}
      onChange={(e) => mutation.mutate(e.target.value as Role)}
    >
      {(["member", "team_lead", "ceo"] as Role[]).map((role) => (
        <option key={role} value={role}>
          {roleLabel(role)}
        </option>
      ))}
    </Select>
  );
}

function FlagToggle({
  user,
  field,
  onDone,
}: {
  user: User;
  field: "is_admin" | "can_review";
  onDone: () => void;
}) {
  const mutation = useMutation({
    mutationFn: (value: boolean) =>
      api(`/users/${user.id}`, { method: "PATCH", json: { [field]: value } }),
    onSuccess: onDone,
    onError: (error) =>
      toast.error(error instanceof ApiError ? error.message : "Could not update the flag"),
  });

  const label = field === "is_admin" ? "admin" : "review";
  return (
    <button
      type="button"
      disabled={mutation.isPending}
      onClick={() => mutation.mutate(!user[field])}
      className="rounded-full border border-dashed border-border px-2 py-0.5 text-xs text-muted-foreground hover:border-primary hover:text-primary disabled:opacity-50"
    >
      + {label}
    </button>
  );
}

function CreateUserDialog({
  open,
  onClose,
  onDone,
  onIssued,
}: {
  open: boolean;
  onClose: () => void;
  onDone: () => void;
  onIssued: (name: string, password: string | null) => void;
}) {
  const [email, setEmail] = useState("");
  const [fullName, setFullName] = useState("");
  const [role, setRole] = useState<Role>("member");
  const [isAdmin, setIsAdmin] = useState(false);
  const [canReview, setCanReview] = useState(false);
  const [password, setPassword] = useState("");

  const mutation = useMutation({
    mutationFn: () =>
      api<CreatedUser>("/users", {
        method: "POST",
        json: {
          email: email.trim(),
          full_name: fullName.trim(),
          role,
          is_admin: isAdmin,
          can_review: canReview,
          password: password || null,
        },
      }),
    onSuccess: async (created) => {
      toast.success(`Created ${created.full_name}`);
      setEmail("");
      setFullName("");
      setPassword("");
      setIsAdmin(false);
      setCanReview(false);
      onClose();
      onIssued(created.full_name, created.temporary_password);
      await onDone();
    },
    onError: (error) =>
      toast.error(error instanceof ApiError ? error.message : "Could not create the user"),
  });

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Create a user"
      description="Leave the password blank to generate a temporary one, shown once."
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            onClick={() => mutation.mutate()}
            loading={mutation.isPending}
            disabled={!email.trim() || !fullName.trim()}
          >
            Create
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <Field label="Full name">
          <Input value={fullName} onChange={(e) => setFullName(e.target.value)} maxLength={200} />
        </Field>
        <Field label="Email">
          <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Role">
            <Select value={role} onChange={(e) => setRole(e.target.value as Role)}>
              {(["member", "team_lead", "ceo"] as Role[]).map((value) => (
                <option key={value} value={value}>
                  {roleLabel(value)}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Password" hint="Leave blank to auto-generate">
            <Input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="10+ characters"
            />
          </Field>
        </div>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={isAdmin} onChange={(e) => setIsAdmin(e.target.checked)} />
          Administrator (user management only)
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={canReview} onChange={(e) => setCanReview(e.target.checked)} />
          Can review and approve work
        </label>
      </div>
    </Dialog>
  );
}

function DeactivateDialog({
  user,
  directory,
  onClose,
  onConfirm,
}: {
  user: User | null;
  directory: DirectoryEntry[];
  onClose: () => void;
  onConfirm: (reassignTo: number | null) => void;
}) {
  const [reassignTo, setReassignTo] = useState("");
  return (
    <Dialog
      open={user !== null}
      onClose={onClose}
      title={`Deactivate ${user?.full_name ?? ""}?`}
      description="Their sessions end immediately. Any running timer is closed and open tasks are reassigned. Historical records keep their name."
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="destructive" onClick={() => onConfirm(reassignTo ? Number(reassignTo) : null)}>
            Deactivate
          </Button>
        </>
      }
    >
      <Field
        label="Reassign open tasks to"
        hint="Required if they have open tasks."
      >
        <Select value={reassignTo} onChange={(e) => setReassignTo(e.target.value)}>
          <option value="">No one</option>
          {directory
            .filter((d) => d.id !== user?.id)
            .map((entry) => (
              <option key={entry.id} value={entry.id}>
                {entry.full_name}
              </option>
            ))}
        </Select>
      </Field>
    </Dialog>
  );
}

function IssuedPasswordDialog({
  issued,
  onClose,
}: {
  issued: { name: string; password: string | null } | null;
  onClose: () => void;
}) {
  return (
    <Dialog
      open={issued !== null}
      onClose={onClose}
      title="Temporary password"
      description="This is shown once. Copy it now — it cannot be retrieved later."
      footer={
        <Button onClick={onClose}>Done</Button>
      }
    >
      <div className="rounded-md border border-border bg-muted p-4">
        <p className="text-sm font-medium">{issued?.name}</p>
        <code className="mt-1 block break-all text-sm">{issued?.password}</code>
      </div>
      <p className="mt-3 text-xs text-muted-foreground">
        They must change it at first sign-in. Existing sessions were signed out.
      </p>
    </Dialog>
  );
}