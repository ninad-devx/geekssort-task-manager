"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";

import { AuthProvider } from "@/lib/auth";
import type { SessionInfo } from "@/lib/types";

/**
 * On public pages (login, change-password) no session is seeded, so `useAuth()` simply
 * reports no user. On protected pages the server layout seeds it before rendering.
 */
export function Providers({
  children,
  initialSession,
}: {
  children: ReactNode;
  initialSession?: SessionInfo;
}) {
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            retry: (failureCount, error) => {
              // never retry an auth or permission failure
              const status = (error as { status?: number })?.status;
              if (status === 401 || status === 403 || status === 404) return false;
              return failureCount < 2;
            },
            refetchOnWindowFocus: true,
            staleTime: 15_000,
          },
        },
      }),
  );

  if (initialSession) {
    client.setQueryData(["session"], initialSession);
  }

  return (
    <QueryClientProvider client={client}>
      <AuthProvider>{children}</AuthProvider>
    </QueryClientProvider>
  );
}