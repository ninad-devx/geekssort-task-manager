import "server-only";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { cache } from "react";

import type { SessionInfo } from "@/lib/types";

const API_ORIGIN = process.env.API_ORIGIN ?? "http://127.0.0.1:8000";
const COOKIE_NAME = process.env.SESSION_COOKIE ?? "mos_session";

/**
 * Data Access Layer. The session cookie is HttpOnly (D-01) so it cannot be read by
 * page scripts; it is read here on the server and forwarded to the API, which is the
 * only component that can validate it.
 */
async function fetchSession(): Promise<SessionInfo | null> {
  const token = (await cookies()).get(COOKIE_NAME)?.value;
  if (!token) return null;

  try {
    const response = await fetch(`${API_ORIGIN}/api/auth/me`, {
      headers: { cookie: `${COOKIE_NAME}=${token}`, accept: "application/json" },
      cache: "no-store",
    });
    if (!response.ok) return null;
    return (await response.json()) as SessionInfo;
  } catch {
    // The API being unreachable is not a reason to hang on a spinner.
    return null;
  }
}

/** Deduplicated within a single render pass. */
export const getSession = cache(fetchSession);

/**
 * Gate for every authenticated page. This runs on the server, so an unauthenticated
 * visitor gets a real redirect instead of a client-side one that can deadlock.
 */
export const requireSession = cache(async () => {
  const session = await getSession();
  if (!session) redirect("/login");
  // While must_change_password is set, every API call except /auth/me and
  // /auth/change-password returns 403 PASSWORD_CHANGE_REQUIRED (FR-AUTH-006).
  if (session.user.must_change_password) redirect("/change-password");
  return session;
});

/** Redirects an already-signed-in visitor away from the login page. */
export async function redirectIfSignedIn() {
  const session = await getSession();
  if (session) redirect(session.user.must_change_password ? "/change-password" : "/");
}