"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Field, Input } from "@/components/ui/form";
import { ApiError } from "@/lib/api";
import { useAuth } from "@/lib/auth";

export function LoginForm() {
  const { login } = useAuth();
  const router = useRouter();
  const params = useSearchParams();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const next = params.get("next") ?? "/";

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    try {
      await login(username.trim().toLowerCase(), password);
      toast.success("Signed in");
      // The session cookie is set; the (app) layout resolves it server-side on the
      // next navigation, so a full refresh is what guarantees a clean auth state.
      router.replace(next);
      router.refresh();
    } catch (error) {
      toast.error(error instanceof ApiError ? error.message : "Could not sign in");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-[#eceef0]/60 px-4">
      <div className="w-full max-w-sm rounded-3xl border border-border/80 bg-card p-7 shadow-[0_8px_30px_rgba(0,0,0,0.04)]">
        <div className="mb-6 flex flex-col items-center text-center">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src="/logo.png"
            alt="Taskssort logo"
            className="mb-3 h-12 w-12 rounded-full object-contain"
          />
          <h1 className="text-xl font-bold tracking-tight">Taskssort</h1>
          <p className="mt-1 text-sm text-muted-foreground">Sign in with your username</p>
        </div>
        <form className="flex flex-col gap-4" onSubmit={submit}>
          <Field label="Username">
            <Input
              type="text"
              autoComplete="username"
              required
              autoFocus
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder="e.g. superadmin"
            />
          </Field>
          <Field label="Password">
            <Input
              type="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Enter your password"
            />
          </Field>
          <Button type="submit" className="w-full" loading={busy}>
            Sign in
          </Button>
        </form>
        <p className="mt-5 text-center text-xs text-muted-foreground">
          Accounts are managed by an administrator.
        </p>
      </div>
    </div>
  );
}
