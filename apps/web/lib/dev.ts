import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { getDb, type DB } from "@il/core/db";
import { devAuthEnabled } from "./flags";
import { errorResponse } from "./api";

/** Dev-only routes: 404 unless DEV_AUTH=1 outside production. */
export function devRoute(fn: (db: DB, req: Request) => Promise<Response | unknown>) {
  return async (req: Request) => {
    if (!devAuthEnabled()) return new NextResponse("Not found", { status: 404 });
    try {
      const out = await fn(await getDb(), req);
      return out instanceof Response ? out : NextResponse.json(out);
    } catch (e) {
      return errorResponse(e, randomUUID().slice(0, 8));
    }
  };
}
