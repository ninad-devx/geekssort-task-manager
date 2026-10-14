import { useRouter } from "next/navigation";
import { createContext, useCallback, useContext, useMemo, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { api, ApiError } from "@/lib/api";
import type { Capabilities, DirectoryEntry, SessionInfo, User } from "@/lib/types";

interface AuthValue {
  user: User | null;
  capabilities: Capabilities | null;
  appTimezone: string;
  login: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  changePassword: (current: string, next: string) => Promise<void>;
}

const AuthContext = createContext<AuthValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const router = useRouter();

  const { data, isLoading } = useQuery({
    queryKey: ["session"],
    queryFn: () => api<SessionInfo>("/auth/me"),
    retry: false,
    staleTime: 30_000,
  });

  const session = isLoading ? null : (data ?? null);

  const invalidate = useCallback(async () => {
    await queryClient.invalidateQueries();
  }, [queryClient]);

  const loginMutation = useMutation({
    mutationFn: (input: { email: string; password: string }) =>
      api<SessionInfo>("/auth/login", { method: "POST", json: input }),
    onSuccess: invalidate,
  });

  const logoutMutation = useMutation({
    mutationFn: () => api<void>("/auth/logout", { method: "POST" }),
    onSuccess: () => {
      queryClient.clear();
      router.replace("/login");
      router.refresh();
    },
  });

  const changePasswordMutation = useMutation({
    mutationFn: (input: { current_password: string; new_password: string }) =>
      api<void>("/auth/change-password", { method: "POST", json: input }),
    onSuccess: invalidate,
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
    }),
    [session, loginMutation, logoutMutation, changePasswordMutation],
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

export function isUnauthorized(error: unknown): boolean {
  return error instanceof ApiError && error.status === 401;
}