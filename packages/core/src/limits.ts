import { and, eq, isNull, lt, or, sql } from "drizzle-orm";
import type { DB } from "./db/client.ts";
import { AI_CALLS_PER_HOUR, users } from "./db/schema.ts";
import { ApiError } from "./errors.ts";

const windowOver = sql`(${users.aiWindowStart} is null or ${users.aiWindowStart} < now() - interval '1 hour')`;

/** Reserves one AI call in a fixed one-hour window, atomically, before the call is made. */
export async function reserveAiCall(db: DB, userId: string) {
  const ok = await db.update(users).set({
    aiCallsInWindow: sql`case when ${windowOver} then 1 else ${users.aiCallsInWindow} + 1 end`,
    aiWindowStart: sql`case when ${windowOver} then now() else ${users.aiWindowStart} end`,
  }).where(and(eq(users.id, userId), or(isNull(users.aiWindowStart), lt(users.aiWindowStart, sql`now() - interval '1 hour'`), lt(users.aiCallsInWindow, AI_CALLS_PER_HOUR))))
    .returning({ id: users.id });
  if (ok.length) return;
  const [u] = await db.select({ retry: sql<number>`ceil(extract(epoch from (${users.aiWindowStart} + interval '1 hour' - now())))::int` })
    .from(users).where(eq(users.id, userId));
  throw new ApiError(429, "ai_rate_limited", `You've used ${AI_CALLS_PER_HOUR} AI calls this hour. Try again later or send as written.`,
    { retryable: true, retry_after: Math.max(1, u?.retry ?? 60), limit: AI_CALLS_PER_HOUR });
}
