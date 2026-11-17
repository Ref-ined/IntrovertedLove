"use client";

export type Problem = { status: number; code: string; detail: string; retryable?: boolean; retry_after?: number; limit?: number; used?: number };

export class ApiFail extends Error {
  constructor(readonly p: Problem) { super(p.detail); }
}

/** Calls /api/v1; throws ApiFail with the problem body on any non-2xx. */
export async function api<T = any>(path: string, opts: { method?: string; body?: unknown } = {}): Promise<T> {
  const res = await fetch(`/api/v1${path}`, {
    method: opts.method ?? (opts.body ? "POST" : "GET"),
    headers: opts.body ? { "content-type": "application/json" } : undefined,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiFail({ status: res.status, code: json.code ?? "internal", detail: json.detail ?? "Something went wrong.", ...json });
  return json as T;
}

export const inviteLink = (code: string) => `${location.origin}/pair?code=${code}`;
