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

  const response = await fetch(path.startsWith("/api") ? path : `/api${path}`, {
    ...options,
    method,
    headers,
    body,
    credentials: "same-origin",
  });

  if (response.status === 204) return undefined as T;

  const text = await response.text();
  const payload = text ? safeJson(text) : {};

  if (!response.ok) {
    const detail =
      payload && typeof payload === "object" && "detail" in payload
        ? (payload as { detail: Record<string, unknown> }).detail
        : { code: "ERROR", message: response.statusText };
    throw new ApiError(response.status, detail as Record<string, unknown>);
  }
  return payload as T;
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return {};
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