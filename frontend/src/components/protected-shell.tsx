"use client";

import { useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { useEffect } from "react";

import { AppShell } from "@/components/app-shell";
import { Spinner } from "@/components/ui/card";
import { useAuth } from "@/lib/auth";

/** Gate for every authenticated page. Not logged in -> /login. */
export function ProtectedShell({ children }: { children: React.ReactNode }) {
  const { user } = useAuth();
  const router = useRouter();
  const queryClient = useQueryClient();
  const session = queryClient.getQueryData(["session"]) as { user?: unknown } | undefined;

  useEffect(() => {
    if (!user && session === undefined) return; // still loading
    if (!user) {
      router.replace("/login");
    }
  }, [user, session, router]);

  if (!user) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <Spinner label="Checking your session" />
      </div>
    );
  }

  return <AppShell>{children}</AppShell>;
}