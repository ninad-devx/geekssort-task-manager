"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, CheckCircle2, Copy, KeyRound, Plus, ShieldCheck, UserMinus, Users } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { PageHeader, roleLabel } from "@/components/app-shell";
import { Avatar } from "@/components/avatar";
import { Button } from "@/components/ui/button";
import { Card, CardContent, EmptyState, ErrorState, Spinner } from "@/components/ui/card";
import {
  Badge,
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

  const invalidate = async () => {
    await client.invalidateQueries({ queryKey: ["users"] });
    await client.invalidateQueries({ queryKey: ["directory"] });
  };

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
    mutationFn: ({ target, newPassword }: { target: User; newPassword: string }) =>
      api<CreatedUser>(`/users/${target.id}/reset-password`, {
        method: "POST",
        json: newPassword.trim() ? { new_password: newPassword.trim() } : {},
      }),
    onSuccess: async (result, variables) => {
      setResetting(null);
      if (variables.newPassword.trim()) {
        toast.success(`Password updated for ${result.full_name}`);
      } else {
        setIssued({ name: result.full_name, password: result.temporary_password });
      }
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

  const allUsers = users.data ?? [];
  const activeCount = allUsers.filter((u) => u.is_active).length;
  const adminCount = allUsers.filter((u) => u.is_admin).length;
  const reviewerCount = allUsers.filter((u) => u.can_review).length;

  return (
    <>
      <PageHeader
        title="Users"
        description="Accounts, roles and flags. People are deactivated, never deleted, so history keeps their name."
        actions={
          <Button onClick={() => setCreateOpen(true)}>
            <Plus className="h-4 w-4" aria-hidden />
            New User
          </Button>
        }
      />

      {/* Summary KPI Strip */}
      <div className="mb-5 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <div className="flex items-center justify-between rounded-2xl p-5 hero-green-card shadow-[0_8px_24px_rgba(20,83,56,0.18)]">
          <div>
            <p className="text-xs font-medium text-white/85">Total Accounts</p>
            <p className="mt-1 tabular text-3xl font-bold text-white">{allUsers.length}</p>
            <p className="mt-1 text-xs text-[#a9dfc2]">{activeCount} currently active</p>
          </div>
          <span className="flex h-10 w-10 items-center justify-center rounded-2xl bg-white/15 text-white">
            <Users className="h-5 w-5" aria-hidden />
          </span>
        </div>

        <Card className="flex items-center justify-between p-5">
          <div>
            <p className="text-xs font-medium text-muted-foreground">Active Members</p>
            <p className="mt-1 tabular text-3xl font-bold text-foreground">{activeCount}</p>
            <p className="mt-1 text-xs text-[#1f7a52]">Can sign in & track time</p>
          </div>
          <span className="flex h-10 w-10 items-center justify-center rounded-2xl bg-[#eaf4ef] text-[#145338]">
            <CheckCircle2 className="h-5 w-5" aria-hidden />
          </span>
        </Card>

        <Card className="flex items-center justify-between p-5">
          <div>
            <p className="text-xs font-medium text-muted-foreground">Administrators</p>
            <p className="mt-1 tabular text-3xl font-bold text-foreground">{adminCount}</p>
            <p className="mt-1 text-xs text-muted-foreground">Manage users & permissions</p>
          </div>
          <span className="flex h-10 w-10 items-center justify-center rounded-2xl bg-[#eaf4ef] text-[#145338]">
            <ShieldCheck className="h-5 w-5" aria-hidden />
          </span>
        </Card>

        <Card className="flex items-center justify-between p-5">
          <div>
            <p className="text-xs font-medium text-muted-foreground">Reviewers</p>
            <p className="mt-1 tabular text-3xl font-bold text-foreground">{reviewerCount}</p>
            <p className="mt-1 text-xs text-muted-foreground">Can approve work</p>
          </div>
          <span className="flex h-10 w-10 items-center justify-center rounded-2xl bg-[#eaf4ef] text-[#145338]">
            <KeyRound className="h-5 w-5" aria-hidden />
          </span>
        </Card>
      </div>

      {users.isLoading ? (
        <Spinner label="Loading users" />
      ) : users.isError ? (
        <ErrorState
          message={users.error instanceof ApiError ? users.error.message : "Could not load users."}
          onRetry={() => void users.refetch()}
        />
      ) : (
        <Card className="overflow-hidden">
          <CardContent className="overflow-x-auto p-0">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border/70 bg-muted/30 text-left text-xs uppercase tracking-wider text-muted-foreground">
                  <th className="px-5 py-3.5 font-semibold">Person</th>
                  <th className="px-4 py-3.5 font-semibold">Username</th>
                  <th className="px-4 py-3.5 font-semibold">Role</th>
                  <th className="px-4 py-3.5 font-semibold">Flags</th>
                  <th className="px-4 py-3.5 font-semibold">Status</th>
                  <th className="px-5 py-3.5" />
                </tr>
              </thead>
              <tbody className="divide-y divide-border/70">
                {allUsers.map((row) => (
                  <tr key={row.id} className="transition-colors hover:bg-muted/25">
                    <td className="px-5 py-3.5 font-semibold">
                      <div className="flex items-center gap-3">
                        <Avatar person={row} size="sm" />
                        <span>
                          {row.full_name}
                          {row.id === me?.id ? (
                            <span className="ml-2 rounded-full bg-[#eaf4ef] px-2 py-0.5 text-[10px] font-semibold text-[#145338]">
                              you
                            </span>
                          ) : null}
                        </span>
                      </div>
                    </td>
                    <td className="px-4 py-3.5 font-mono text-xs text-muted-foreground">
                      {row.email}
                    </td>
                    <td className="px-4 py-3.5">
                      <RoleSelect user={row} onDone={invalidate} />
                    </td>
                    <td className="px-4 py-3.5">
                      <div className="flex flex-wrap items-center gap-1.5">
                        {row.is_admin ? <Badge variant="default">admin</Badge> : null}
                        {row.can_review ? <Badge variant="outline">can review</Badge> : null}
                        <FlagToggle user={row} field="is_admin" onDone={invalidate} />
                        <FlagToggle user={row} field="can_review" onDone={invalidate} />
                      </div>
                    </td>
                    <td className="px-4 py-3.5">
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
                    <td className="px-5 py-3.5">
                      <div className="flex justify-end gap-1.5">
                        <Button variant="outline" size="sm" onClick={() => setResetting(row)}>
                          <KeyRound className="h-3.5 w-3.5" aria-hidden />
                          Reset
                        </Button>
                        {row.id !== me?.id ? (
                          row.is_active ? (
                            <Button variant="ghost" size="sm" onClick={() => setDeactivating(row)}>
                              <UserMinus className="h-3.5 w-3.5" aria-hidden />
                              Deactivate
                            </Button>
                          ) : (
                            <Button
                              variant="outline"
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

      {resetting ? (
        <ResetPasswordDialog
          key={resetting.id}
          user={resetting}
          loading={resetPassword.isPending}
          onClose={() => setResetting(null)}
          onSubmit={(newPassword) => resetPassword.mutate({ target: resetting, newPassword })}
        />
      ) : null}

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
      className="h-8 w-auto rounded-full px-3 text-xs"
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

  const granted = Boolean(user[field]);
  const label = field === "is_admin" ? "admin" : "review";
  return (
    <button
      type="button"
      disabled={mutation.isPending}
      onClick={() => mutation.mutate(!granted)}
      title={granted ? `Remove ${label} rights` : `Grant ${label} rights`}
      aria-label={
        field === "is_admin"
          ? granted
            ? `Remove admin rights from ${user.full_name}`
            : `Make ${user.full_name} an admin`
          : granted
            ? `Remove review rights from ${user.full_name}`
            : `Let ${user.full_name} review work`
      }
      className={`rounded-full border px-2.5 py-0.5 text-xs font-medium transition-colors disabled:opacity-50 ${
        granted
          ? "border-border text-muted-foreground hover:border-destructive hover:text-destructive"
          : "border-dashed border-border text-muted-foreground hover:border-[#145338] hover:text-[#145338]"
      }`}
    >
      {granted ? `− ${label}` : `+ ${label}`}
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
  const [username, setUsername] = useState("");
  const [fullName, setFullName] = useState("");
  const [role, setRole] = useState<Role>("member");
  const [isAdmin, setIsAdmin] = useState(false);
  const [canReview, setCanReview] = useState(false);
  const [password, setPassword] = useState("");

  const clearForm = () => {
    setUsername("");
    setFullName("");
    setRole("member");
    setIsAdmin(false);
    setCanReview(false);
    setPassword("");
  };
  const handleClose = () => {
    clearForm();
    onClose();
  };

  const mutation = useMutation({
    mutationFn: () =>
      api<CreatedUser>("/users", {
        method: "POST",
        json: {
          email: username.trim(),
          full_name: fullName.trim(),
          role,
          is_admin: isAdmin,
          can_review: canReview,
          password: password || null,
        },
      }),
    onSuccess: async (created) => {
      toast.success(`Created ${created.full_name}`);
      clearForm();
      onClose();
      if (created.temporary_password) {
        onIssued(created.full_name, created.temporary_password);
      }
      await onDone();
    },
    onError: (error) =>
      toast.error(error instanceof ApiError ? error.message : "Could not create the user"),
  });

  return (
    <Dialog
      open={open}
      onClose={handleClose}
      title="Create a user"
      description="Enter a username and optional password (or leave password blank to generate a temporary one)."
      footer={
        <>
          <Button variant="outline" onClick={handleClose}>
            Cancel
          </Button>
          <Button
            onClick={() => mutation.mutate()}
            loading={mutation.isPending}
            disabled={!username.trim() || !fullName.trim()}
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
        <Field label="Username">
          <Input
            type="text"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            placeholder="e.g. alex or superadmin"
          />
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

function ResetPasswordDialog({
  user,
  loading,
  onClose,
  onSubmit,
}: {
  user: User;
  loading: boolean;
  onClose: () => void;
  onSubmit: (newPassword: string) => void;
}) {
  const [newPassword, setNewPassword] = useState("");
  const tooShort = newPassword.trim().length > 0 && newPassword.trim().length < 10;

  return (
    <Dialog
      open
      onClose={onClose}
      title={`Reset password for ${user.full_name}`}
      description="Enter a new password directly (10+ characters), or leave blank to generate a one-time temporary password."
      onSubmit={() => {
        if (tooShort) return;
        onSubmit(newPassword);
      }}
      submitLabel={newPassword.trim() ? "Save new password" : "Generate temporary password"}
      submitting={loading}
    >
      <Field
        label="New password (optional)"
        hint="If you set a password here, it takes effect immediately without requiring a password change at login."
        error={tooShort ? "Password must be at least 10 characters" : undefined}
      >
        <Input
          type="text"
          autoFocus
          value={newPassword}
          onChange={(e) => setNewPassword(e.target.value)}
          placeholder="Leave blank to auto-generate temporary password"
        />
      </Field>
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
  const [copied, setCopied] = useState(false);

  const copyPassword = async () => {
    if (!issued?.password) return;
    try {
      await navigator.clipboard.writeText(issued.password);
      setCopied(true);
      toast.success("Temporary password copied to clipboard");
      setTimeout(() => setCopied(false), 2500);
    } catch {
      toast.error("Could not copy automatically — please select and copy the text");
    }
  };

  return (
    <Dialog
      open={issued !== null}
      onClose={onClose}
      title="Temporary password"
      description="This is shown once. Copy it now — it cannot be retrieved later."
      footer={
        <div className="flex w-full items-center justify-end gap-2">
          <Button variant="outline" onClick={() => void copyPassword()}>
            {copied ? <Check className="h-4 w-4 text-[#145338]" /> : <Copy className="h-4 w-4" />}
            {copied ? "Copied" : "Copy password"}
          </Button>
          <Button onClick={onClose}>Done</Button>
        </div>
      }
    >
      <div className="rounded-xl border border-[#1f7a52]/30 bg-[#eaf4ef]/50 p-4">
        <p className="text-xs font-semibold tracking-wider text-muted-foreground uppercase">
          Account: {issued?.name}
        </p>
        <code className="mt-1.5 block select-all break-all font-mono text-base font-bold text-[#145338]">
          {issued?.password}
        </code>
      </div>
      <p className="mt-3 text-xs text-muted-foreground">
        Share this temporary password with the user. Other active sessions for this user were signed out.
      </p>
    </Dialog>
  );
}