/**
 * Single API entry point. The session cookie is HttpOnly and unreadable by page
 * scripts (D-01); every write carries the mandatory X-Requested-With header (D-04).
 */

export class ApiError extends Error {
  status: number;
  code: string;
  detail: Record<string, unknown>;

  constructor(status: number, detail: Record<string, unknown>) {
    super(String(detail?.message ?? detail?.code ?? "Request failed"));
    this.name = "ApiError";
    this.status = status;
    this.code = String(detail?.code ?? "ERROR");
    this.detail = detail ?? {};
  }
}

/**
 * The request never reached the API -- the server is down, or the network is.
 *
 * Kept distinct from `ApiError` on purpose. Previously a failed `fetch` fell
 * through to a generic message and, worse, an unreachable server was reported
 * as "no data", which a list page then rendered as an empty state. Telling the
 * two apart is what lets the UI say "you're offline" instead of "you have no
 * tasks" and lets the server-side gate avoid bouncing everyone to /login.
 */
export class NetworkError extends Error {
  constructor(message = "Could not reach the server") {
    super(message);
    this.name = "NetworkError";
  }
}

/** Raised when the session is no longer valid. AuthProvider listens for it. */
export const SESSION_EXPIRED_EVENT = "mos:session-expired";

type Options = Omit<RequestInit, "body"> & { body?: unknown; json?: unknown };

export async function api<T>(path: string, options: Options = {}): Promise<T> {
  const method = (options.method ?? "GET").toUpperCase();
  const isWrite = !["GET", "HEAD", "OPTIONS"].includes(method);

  const headers = new Headers(options.headers);
  headers.set("Accept", "application/json");
  if (isWrite) headers.set("X-Requested-With", "marketingos");

  let body: BodyInit | undefined;
  if (options.json !== undefined) {
    headers.set("Content-Type", "application/json");
    body = JSON.stringify(options.json);
  } else if (options.body !== undefined) {
    body = options.body as BodyInit;
  }

  let response: Response;
  try {
    response = await fetch(path.startsWith("/api") ? path : `/api${path}`, {
      ...options,
      method,
      headers,
      body,
      credentials: "same-origin",
    });
  } catch {
    throw new NetworkError();
  }

  if (response.status === 204) return undefined as T;

  const text = await response.text();

  if (!response.ok) {
    const detail = parseErrorDetail(text, response.statusText);
    // A 401 anywhere means the cookie is gone or expired. Announce it once so
    // the app can send the person back to the login page instead of stranding
    // them on an error screen.
    if (response.status === 401 && typeof window !== "undefined") {
      window.dispatchEvent(new CustomEvent(SESSION_EXPIRED_EVENT));
    }
    throw new ApiError(response.status, detail);
  }

  // A 200 that is not JSON means something between here and the API answered
  // instead -- typically a login redirect served as HTML. Returning `{}` for
  // that made every list page claim the user had nothing.
  if (text && !looksLikeJson(text)) {
    throw new ApiError(response.status, {
      code: "UNEXPECTED_RESPONSE",
      message: "The server sent a response this page could not read. Try again.",
    });
  }
  return (text ? (JSON.parse(text) as unknown) : {}) as T;
}

function looksLikeJson(text: string): boolean {
  const head = text.trimStart()[0];
  return head === "{" || head === "[" || head === '"';
}

function parseErrorDetail(text: string, statusText: string): Record<string, unknown> {
  const fallback = { code: "ERROR", message: statusText || "Request failed" };
  if (!text || !looksLikeJson(text)) return fallback;
  try {
    const payload: unknown = JSON.parse(text);
    if (payload && typeof payload === "object" && "detail" in payload) {
      const detail = (payload as { detail: unknown }).detail;
      if (detail && typeof detail === "object") return detail as Record<string, unknown>;
      return { code: "ERROR", message: String(detail) };
    }
    return payload as Record<string, unknown>;
  } catch {
    return fallback;
  }
}

export function qs(params: Record<string, string | number | boolean | undefined | null>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === "") continue;
    search.set(key, String(value));
  }
  const out = search.toString();
  return out ? `?${out}` : "";
}

/** A one-line message for anything thrown by `api`. */
export function errorMessage(error: unknown): string {
  if (error instanceof NetworkError) return "You appear to be offline. Check your connection and try again.";
  if (error instanceof ApiError) return error.message;
  if (error instanceof Error) return error.message;
  return "Something went wrong";
}