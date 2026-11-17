/** Every API failure: an RFC 9457 problem with a stable code (docs/ERRORS.md#<code>). */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly detail: string,
    readonly extra: { retryable?: boolean; retry_after?: number; limit?: number; used?: number; fields?: { path: string; message: string }[] } = {},
  ) {
    super(detail);
  }
}

const TITLES: Record<number, string> = {
  400: "Bad request", 402: "Upgrade required", 403: "Forbidden", 404: "Not found", 409: "Conflict",
  410: "Gone", 415: "Unsupported media type", 422: "Unprocessable", 429: "Too many requests",
  500: "Internal error", 502: "Upstream failed", 503: "Temporarily unavailable",
};

export function problemBody(e: ApiError, requestId: string) {
  return {
    type: `/docs/errors#${e.code}`,
    title: TITLES[e.status] ?? "Error",
    status: e.status,
    code: e.code,
    detail: e.detail,
    retryable: e.extra.retryable ?? false,
    request_id: requestId,
    ...(e.extra.retry_after !== undefined && { retry_after: e.extra.retry_after }),
    ...(e.extra.limit !== undefined && { limit: e.extra.limit }),
    ...(e.extra.used !== undefined && { used: e.extra.used }),
    ...(e.extra.fields && { fields: e.extra.fields }),
  };
}

/** Every code the API can return; a test checks each has an anchor in docs/ERRORS.md. */
export const ERROR_CODES = [
  "invalid_input", "invalid_cursor", "unsupported_media_type", "unauthenticated", "age_required", "age_blocked",
  "questionnaire_required", "own_code", "already_paired", "partner_unavailable", "code_expired", "rate_limited",
  "ai_rate_limited", "not_paired", "not_found", "already_sent", "undo_window_closed", "upgrade_required",
  "free_translations_used_up", "free_previews_used_up", "free_shares_used_up", "safety_requires_as_written",
  "invalid_token", "translate_failed", "busy", "account_delete_incomplete", "internal",
] as const;
