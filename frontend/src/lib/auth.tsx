"use client";

import { useRouter } from "next/navigation";
import { createContext, useCallback, useContext, useEffect, useMemo, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { api, ApiError, SESSION_EXPIRED_EVENT } from "@/lib/api";
import type { Capabilities, DirectoryEntry, SessionInfo, User } from "@/lib/types";

interface AuthValue {
  user: User | null;
  capabilities: Capabilities | null;
  appTimezone: string;
  login: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  changePassword: (current: string, next: string) => Promise<void>;
  updateProfile: (input: {
    display_name?: string | null;
    avatar_url?: string | null;
    avatar_color?: string | null;
  }) => Promise<void>;
}

const AuthContext = createContext<AuthValue | null>(null);

const SESSION_KEY = ["session"];

/**
 * Reads the session from the query cache. The server layout resolves it before
 * the page renders and seeds the cache, which is what makes an unauthenticated
 * visitor get a real redirect instead of an endless "Checking your session"
 * spinner.
 *
 * `enabled: false` was never lifted, so the session was read once at first
 * paint and never again: a cookie that expired four hours into a shift left
 * every query 401-ing with nothing on screen to explain it. Revalidation now
 * runs on window focus, and any 401 anywhere in the app sends the person back
 * to the login page.
 */
export function AuthProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const router = useRouter();

  const { data: session } = useQuery({
    queryKey: SESSION_KEY,
    queryFn: () => api<SessionInfo>("/auth/me"),
    retry: false,
    staleTime: 60_000,
    refetchOnWindowFocus: true,
    refetchInterval: 5 * 60_000,
  });

  // One 401 anywhere means the cookie is gone. Clear the cache so nothing stale
  // is rendered on the way out, then send them to sign in again.
  useEffect(() => {
    const onExpired = () => {
      queryClient.clear();
      router.replace("/login");
      router.refresh();
    };
    window.addEventListener(SESSION_EXPIRED_EVENT, onExpired);
    return () => window.removeEventListener(SESSION_EXPIRED_EVENT, onExpired);
  }, [queryClient, router]);

  const loginMutation = useMutation({
    mutationFn: (input: { email: string; password: string }) =>
      api<SessionInfo>("/auth/login", { method: "POST", json: input }),
    onSuccess: (result) => {
      queryClient.setQueryData(SESSION_KEY, result);
    },
  });

  const logoutMutation = useMutation({
    mutationFn: () => api<void>("/auth/logout", { method: "POST" }),
    onSuccess: () => {
      queryClient.clear();
      router.replace("/login");
      router.refresh();
    },
  });

  /** Re-read the session so a change to your own powers applies immediately. */
  const refreshSession = useCallback(
    () => queryClient.invalidateQueries({ queryKey: SESSION_KEY }),
    [queryClient],
  );

  const changePasswordMutation = useMutation({
    mutationFn: (input: { current_password: string; new_password: string }) =>
      api<void>("/auth/change-password", { method: "POST", json: input }),
    onSuccess: refreshSession,
  });

  // Editing your own display name, picture or colour is allowed for everybody,
  // so it deliberately does not go through the admin-only users endpoint.
  const updateProfileMutation = useMutation({
    mutationFn: (input: {
      display_name?: string | null;
      avatar_url?: string | null;
      avatar_color?: string | null;
    }) => api<User>(`/users/${session?.user.id}`, { method: "PATCH", json: input }),
    onSuccess: refreshSession,
  });

  const value = useMemo<AuthValue>(
    () => ({
      user: session?.user ?? null,
      capabilities: session?.capabilities ?? null,
      appTimezone: session?.app_timezone ?? "UTC",
      login: async (email, password) => {
        await loginMutation.mutateAsync({ email, password });
      },
      logout: async () => {
        await logoutMutation.mutateAsync();
      },
      changePassword: async (currentPassword, newPassword) => {
        await changePasswordMutation.mutateAsync({
          current_password: currentPassword,
          new_password: newPassword,
        });
      },
      updateProfile: async (input) => {
        await updateProfileMutation.mutateAsync(input);
      },
    }),
    [session, loginMutation, logoutMutation, changePasswordMutation, updateProfileMutation],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used inside AuthProvider");
  return ctx;
}

export function useCapabilities(): Capabilities | null {
  return useAuth().capabilities;
}

export function useDirectory() {
  return useQuery({
    queryKey: ["directory"],
    queryFn: () => api<DirectoryEntry[]>("/users/directory"),
    staleTime: 5 * 60_000,
  });
}

/** Re-reads the session. Use after anything that can change your own powers. */
export function useRefreshSession() {
  const queryClient = useQueryClient();
  return useCallback(
    () => queryClient.invalidateQueries({ queryKey: SESSION_KEY }),
    [queryClient],
  );
}

export function isUnauthorized(error: unknown): boolean {
  return error instanceof ApiError && error.status === 401;
}