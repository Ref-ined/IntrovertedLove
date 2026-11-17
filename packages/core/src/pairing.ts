import { randomInt } from "node:crypto";
import { and, asc, eq, gt, inArray, isNull, lt, or, sql } from "drizzle-orm";
import type { DB } from "./db/client.ts";
import { couples, coupleMembers, messages, pairAttempts, PAIR_ATTEMPTS_PER_HOUR, users } from "./db/schema.ts";
import { ApiError } from "./errors.ts";
import { logEvent } from "./events.ts";
import { activeCouple, hasQuestionnaire, pgCode, requireReady } from "./users.ts";

const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; // 31 symbols, no 0/O/1/I/L
const CODE_DAYS = 7;

export function newCode(): string {
  return Array.from({ length: 10 }, () => ALPHABET[randomInt(ALPHABET.length)]).join("");
}

const freshCode = () => ({ pairCode: newCode(), pairCodeExpiresAt: sql`now() + interval '${sql.raw(String(CODE_DAYS))} days'` });

/** Current code; an expired or used one is rotated atomically so concurrent GETs agree. */
export async function getPairCode(db: DB, userId: string) {
  await requireReady(db, userId);
  for (let i = 0; i < 3; i++) {
    try {
      await db.update(users).set(freshCode())
        .where(and(eq(users.id, userId), or(isNull(users.pairCode), lt(users.pairCodeExpiresAt, sql`now()`))));
      break;
    } catch (e) { if (pgCode(e) !== "23505") throw e; } // code collision: try another
  }
  const [u] = await db.select({ code: users.pairCode, expires: users.pairCodeExpiresAt }).from(users).where(eq(users.id, userId));
  return { code: u.code!, expires_at: u.expires };
}

export async function pair(db: DB, userId: string, rawCode: string) {
  await requireReady(db, userId);
  const code = rawCode.trim().toUpperCase();
  // Insert first, then count: parallel guesses can't slip past the limit.
  await db.insert(pairAttempts).values({ userId });
  const [{ n, retry }] = await db.select({
    n: sql<number>`count(*)::int`,
    retry: sql<number>`ceil(extract(epoch from (min(${pairAttempts.at}) + interval '1 hour' - now())))::int`,
  }).from(pairAttempts).where(and(eq(pairAttempts.userId, userId), gt(pairAttempts.at, sql`now() - interval '1 hour'`)));
  if (n > PAIR_ATTEMPTS_PER_HOUR) {
    throw new ApiError(429, "rate_limited", `Too many code attempts this hour (limit ${PAIR_ATTEMPTS_PER_HOUR}).`, { retryable: true, retry_after: Math.max(1, retry), limit: PAIR_ATTEMPTS_PER_HOUR });
  }
  const [owner] = await db.select().from(users).where(and(eq(users.pairCode, code), gt(users.pairCodeExpiresAt, sql`now()`)));
  if (!owner) throw new ApiError(410, "code_expired", "This invite has expired or was already used. Ask your partner for a new link.");
  if (owner.id === userId) throw new ApiError(400, "own_code", "This is your own invite. Send it to your partner.");
  if (!(await hasQuestionnaire(db, userId)) || !(await hasQuestionnaire(db, owner.id))) {
    throw new ApiError(403, "questionnaire_required", "Both of you need to finish the questionnaire before connecting.");
  }

  try {
    const coupleId = await db.transaction(async (tx) => {
      // Lock both rows in id order so two crossing pair requests can't deadlock or double-pair.
      await tx.select({ id: users.id }).from(users).where(inArray(users.id, [userId, owner.id])).orderBy(asc(users.id)).for("update");
      if (await activeCouple(tx as unknown as DB, userId)) throw new ApiError(409, "already_paired", "You're already connected with someone.");
      if (await activeCouple(tx as unknown as DB, owner.id)) throw new ApiError(409, "partner_unavailable", "The person who sent this invite is already connected.");
      const [c] = await tx.insert(couples).values({}).returning({ id: couples.id });
      await tx.insert(coupleMembers).values([{ coupleId: c.id, userId }, { coupleId: c.id, userId: owner.id }]);
      await tx.update(users).set(freshCode()).where(eq(users.id, owner.id)); // each code works once
      return c.id;
    });
    await logEvent(db, userId, "paired", {}, coupleId);
    return { couple_id: coupleId, partner_name: owner.displayName ?? owner.email ?? "Your partner" };
  } catch (e) {
    if (pgCode(e) === "23505") throw new ApiError(409, "already_paired", "One of you just connected with someone else.");
    throw e;
  }
}

/** Ends the couple: history stays read-only, pending messages are removed and refunded, both codes rotate. */
export async function unpair(db: DB, userId: string) {
  await requireReady(db, userId);
  const c = await activeCouple(db, userId);
  if (!c) throw new ApiError(404, "not_paired", "You're not connected with anyone.");
  await db.transaction(async (tx) => {
    const pending = await tx.delete(messages)
      .where(and(eq(messages.coupleId, c.coupleId), gt(messages.visibleAt, sql`clock_timestamp()`)))
      .returning({ sender: messages.senderId, charged: messages.chargedFreeSlot });
    for (const p of pending.filter((p) => p.charged)) {
      await tx.update(users).set({ freeTranslationsUsed: sql`${users.freeTranslationsUsed} - 1` }).where(eq(users.id, p.sender));
    }
    await tx.update(couples).set({ endedAt: sql`now()` }).where(eq(couples.id, c.coupleId));
    await tx.update(coupleMembers).set({ active: false }).where(eq(coupleMembers.coupleId, c.coupleId));
    const ids = [userId, ...(c.partner ? [c.partner.id] : [])];
    await tx.update(users).set({ pairCode: null, pairCodeExpiresAt: null }).where(inArray(users.id, ids));
  });
  return { ok: true };
}
