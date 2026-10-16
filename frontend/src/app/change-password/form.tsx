"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Field, Input } from "@/components/ui/form";
import { ApiError } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import type { User } from "@/lib/types";

export function ChangePasswordForm({ user, appTimezone }: { user: User; appTimezone: string }) {
  const { changePassword, logout } = useAuth();
  const router = useRouter();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [signingOut, setSigningOut] = useState(false);

  const forced = user.must_change_password;

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (next !== confirm) {
      toast.error("The new passwords do not match");
      return;
    }
    setBusy(true);
    try {
      await changePassword(current, next);
      toast.success("Password changed");
      router.replace("/");
      router.refresh();
    } catch (error) {
      toast.error(error instanceof ApiError ? error.message : "Could not change the password");
    } finally {
      setBusy(false);
    }
  };

  // Always available, so nobody can get stranded on this page.
  const signOut = async () => {
    setSigningOut(true);
    try {
      await logout();
      router.replace("/login");
      router.refresh();
    } catch {
      // even if the server call fails, send them somewhere they can act
      setSigningOut(false);
      toast.error("Could not sign out. Clear your cookies and reload.");
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-[#eceef0]/60 px-4">
      <div className="w-full max-w-sm rounded-3xl border border-border/80 bg-card p-7 shadow-[0_8px_30px_rgba(0,0,0,0.04)]">
        <div className="mb-4 flex items-center gap-2.5">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src="/logo.png"
            alt="Taskssort logo"
            className="h-9 w-9 shrink-0 rounded-full object-contain"
          />
          <span className="text-base font-bold tracking-tight">Taskssort</span>
        </div>
        <h1 className="text-xl font-bold tracking-tight">
          {forced ? "Choose a new password" : "Change your password"}
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {forced
            ? "You must set a new password before you can use Taskssort."
            : `Signed in as ${user.full_name} · ${user.email}`}
        </p>

        <form className="mt-6 flex flex-col gap-4" onSubmit={submit}>
          <Field label="Current password">
            <Input
              type="password"
              autoComplete="current-password"
              required
              autoFocus
              value={current}
              onChange={(e) => setCurrent(e.target.value)}
            />
          </Field>
          <Field label="New password" hint="10 to 128 characters. It must not be your email.">
            <Input
              type="password"
              autoComplete="new-password"
              required
              minLength={10}
              value={next}
              onChange={(e) => setNext(e.target.value)}
            />
          </Field>
          <Field label="Confirm new password">
            <Input
              type="password"
              autoComplete="new-password"
              required
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
            />
          </Field>
          <Button type="submit" className="w-full" loading={busy}>
            Save password
          </Button>
        </form>

        <div className="mt-4 flex flex-col gap-2 border-t border-border pt-4">
          {!forced ? (
            <Button type="button" variant="ghost" className="w-full" onClick={() => router.back()}>
              Cancel
            </Button>
          ) : null}
          <Button
            type="button"
            variant="ghost"
            className="w-full"
            onClick={() => void signOut()}
            loading={signingOut}
          >
            {forced ? "Sign in with a different account" : "Sign out"}
          </Button>
        </div>

        <p className="mt-3 text-center text-xs text-muted-foreground">
          Times are shown in {appTimezone}.
        </p>
      </div>
    </div>
  );
}