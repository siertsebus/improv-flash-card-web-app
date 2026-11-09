import { signal } from "@preact/signals";

export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public details?: any,
  ) {
    super(message);
  }
}

export const loggedOut = signal(false);

export async function api<T = any>(path: string, opts: { method?: string; body?: unknown } = {}): Promise<T> {
  const res = await fetch(path, {
    method: opts.method ?? (opts.body !== undefined ? "POST" : "GET"),
    headers: opts.body !== undefined ? { "Content-Type": "application/json" } : undefined,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    credentials: "same-origin",
  });
  const data: any = await res.json().catch(() => ({}));
  if (res.status === 401 && path !== "/api/login") loggedOut.value = true;
  if (!res.ok) throw new ApiError(data.error ?? `Request failed (${res.status})`, res.status, data.details);
  return data as T;
}

export const tzParam = () => `tz=${new Date().getTimezoneOffset()}`;
