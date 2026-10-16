import "server-only";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { cache } from "react";

import type { SessionInfo } from "@/lib/types";

const API_ORIGIN = process.env.API_ORIGIN ?? "http://127.0.0.1:8000";
const COOKIE_NAME = process.env.SESSION_COOKIE ?? "mos_session";

/**
 * The API could not be reached at all -- it is down, or the network between us
 * and it is. This is deliberately not the same as "not signed in".
 */
export class ApiUnavailableError extends Error {
  constructor(message = "The server is not responding") {
    super(message);
    this.name = "ApiUnavailableError";
  }
}

/**
 * Data Access Layer. The session cookie is HttpOnly (D-01) so it cannot be read by
 * page scripts; it is read here on the server and forwarded to the API, which is the
 * only component that can validate it.
 */
async function fetchSession(): Promise<SessionInfo | null> {
  const token = (await cookies()).get(COOKIE_NAME)?.value;
  if (!token) return null;

  let response: Response;
  try {
    response = await fetch(`${API_ORIGIN}/api/auth/me`, {
      headers: { cookie: `${COOKIE_NAME}=${token}`, accept: "application/json" },
      cache: "no-store",
    });
  } catch {
    // Previously this returned null, which `requireSession` read as "signed
    // out" and redirected to /login. An outage therefore logged the entire
    // company out with no explanation, and signing back in failed too.
    throw new ApiUnavailableError();
  }
  if (!response.ok) return null;

  const text = await response.text();
  try {
    return JSON.parse(text) as SessionInfo;
  } catch {
    // A 200 that is not a session means something answered instead of the API.
    throw new ApiUnavailableError("The server sent a response this app could not read");
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