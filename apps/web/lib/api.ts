import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { ZodError, type z } from "zod";
import { ApiError, problemBody } from "@il/core";
import { getDb, type DB } from "@il/core/db";
import { getUserId, type Who } from "./auth";

type Ctx = { db: DB; who: Who; req: Request; params: Record<string, string> };

/** Wraps a route: JSON-only writes, auth, zod → invalid_input, ApiError → problem+json, anything else → 500 with request_id. */
export function route(fn: (c: Ctx) => Promise<unknown>) {
  return async (req: Request, ctx: { params: Promise<Record<string, string>> }) => {
    const requestId = randomUUID().slice(0, 8);
    try {
      if (!["GET", "HEAD"].includes(req.method) && req.headers.get("content-length") !== "0" && req.method !== "DELETE"
        && !req.headers.get("content-type")?.startsWith("application/json")) {
        throw new ApiError(415, "unsupported_media_type", "Send a JSON body with Content-Type: application/json.");
      }
      const who = await getUserId();
      if (!who) throw new ApiError(401, "unauthenticated", "Sign in first.");
      const out = await fn({ db: await getDb(), who, req, params: await ctx.params });
      return NextResponse.json(out ?? { ok: true });
    } catch (e) {
      return errorResponse(e, requestId);
    }
  };
}

export function errorResponse(e: unknown, requestId: string) {
  let err: ApiError;
  if (e instanceof ApiError) err = e;
  else if (e instanceof ZodError) {
    const fields = e.issues.map((i) => ({ path: i.path.join(".") || "body", message: i.message }));
    err = new ApiError(400, "invalid_input", fields.map((f) => `${f.path}: ${f.message}`).join("; "), { fields });
  } else {
    console.error(`[${requestId}]`, e); // stack to the log only; never message text
    err = new ApiError(500, "internal", "Something went wrong on our side.");
  }
  const headers: Record<string, string> = { "content-type": "application/problem+json" };
  if (err.extra.retry_after) headers["retry-after"] = String(err.extra.retry_after);
  return new NextResponse(JSON.stringify(problemBody(err, requestId)), { status: err.status, headers });
}

export async function body<T extends z.ZodType>(req: Request, schema: T): Promise<z.infer<T>> {
  let json: unknown;
  try { json = await req.json(); } catch { throw new ApiError(400, "invalid_input", "The body isn't valid JSON."); }
  return schema.parse(json);
}
