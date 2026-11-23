import { and, asc, eq, gt, lt, or, sql } from "drizzle-orm";
import { z } from "zod";
import type { DB } from "./db/client.ts";
import {
  coupleMembers, FREE_PREVIEWS, FREE_SHARES, FREE_TRANSLATIONS, FREE_UNPAIRED_PREVIEWS, messages, questionnaire, users,
} from "./db/schema.ts";
import { ApiError } from "./errors.ts";
import { hasPaidAccess } from "./access.ts";
import { getCoach, type Recipient } from "./ai/coach.ts";
import { logEvent } from "./events.ts";
import { reserveAiCall } from "./limits.ts";
import { NEUTRAL_TRAITS, recipientProfile, senderVoice } from "./questionnaire.ts";
import { hashText, mintToken, verifyToken } from "./token.ts";
import { activeCouple, pgCode, requireReady, type User } from "./users.ts";

export const textSchema = z.string().trim().min(1, "Write something first.").max(4000, "The maximum is 4000 characters.");

export function undoWindowSeconds(): number {
  // 0 = deliver at once (the app has no undo button); env.ts rejects bad values at startup.
  const n = Number(process.env.UNDO_WINDOW_SECONDS || 0);
  return Number.isInteger(n) && (n === 0 || n >= 2) ? n : 0;
}

async function recipientFor(db: DB, userId: string): Promise<{ coupleId: string | null; to: Recipient }> {
  const c = await activeCouple(db, userId);
  if (!c?.partner) return { coupleId: c?.coupleId ?? null, to: { name: "your partner", traits: NEUTRAL_TRAITS, shared: false } };
  const [p] = await db.select({ share: users.shareTraits, answers: questionnaire.answers }).from(users)
    .leftJoin(questionnaire, eq(questionnaire.userId, users.id)).where(eq(users.id, c.partner.id));
  const name = c.partner.name ?? "your partner";
  const shared = !!p?.share && !!p.answers;
  return { coupleId: c.coupleId, to: { name, traits: shared ? recipientProfile(p!.answers as Record<string, unknown>) : NEUTRAL_TRAITS, shared } };
}

/** Free users: reserve one preview, atomically, within the paired/unpaired caps. */
async function reservePreview(db: DB, u: User, paired: boolean) {
  const cap = paired ? FREE_PREVIEWS : FREE_UNPAIRED_PREVIEWS;
  const ok = await db.update(users).set({ freePreviewsUsed: sql`${users.freePreviewsUsed} + 1` })
    .where(and(eq(users.id, u.id), lt(users.freePreviewsUsed, cap),
      or(lt(users.freeTranslationsUsed, FREE_TRANSLATIONS), lt(users.freeSharesUsed, FREE_SHARES))))
    .returning({ id: users.id });
  if (ok.length) return;
  const [now] = await db.select().from(users).where(eq(users.id, u.id));
  if (now.freePreviewsUsed >= cap) {
    throw new ApiError(402, "free_previews_used_up",
      paired ? `You've used all ${cap} free previews. Upgrade to keep translating, or send as written.`
        : `You've used the ${cap} previews available before your partner joins. Invite them to unlock the rest.`,
      { limit: cap, used: now.freePreviewsUsed });
  }
  throw new ApiError(402, "free_translations_used_up",
    `You've used your ${FREE_TRANSLATIONS} free translated messages and ${FREE_SHARES} free shares. Upgrade, or send as written.`,
    { limit: FREE_TRANSLATIONS, used: now.freeTranslationsUsed });
}

async function releasePreview(db: DB, userId: string) {
  await db.update(users).set({ freePreviewsUsed: sql`greatest(${users.freePreviewsUsed} - 1, 0)` }).where(eq(users.id, userId));
}

export async function preview(db: DB, userId: string, rawText: string) {
  const u = await requireReady(db, userId);
  const text = textSchema.parse(rawText);
  const paid = hasPaidAccess(u);
  const { coupleId, to } = await recipientFor(db, userId);
  if (!paid) await reservePreview(db, u, !!coupleId);
  try {
    await reserveAiCall(db, userId);
  } catch (e) {
    if (!paid) await releasePreview(db, userId);
    throw e;
  }
  let t;
  try {
    // Partner's answers: how it should land. Sender's own answers: so it still sounds like them.
    const [mine] = await db.select({ answers: questionnaire.answers }).from(questionnaire).where(eq(questionnaire.userId, userId));
    t = await getCoach().translate(text, to, { name: u.displayName ?? "the sender", traits: mine ? senderVoice(mine.answers as Record<string, unknown>) : [] });
  } catch (e) {
    if (!paid) await releasePreview(db, userId);
    const reason = (e as Error)?.name?.includes("Timeout") ? "timeout" : (e as Error)?.message === "invalid_output" ? "invalid_output" : "api_error";
    await logEvent(db, userId, "translation_failed", { reason }, coupleId);
    throw new ApiError(503, "translate_failed", "The translation service didn't answer in time. Nothing was charged or stored.", { retryable: true });
  }
  // One signed token per version, so the sender can send or share whichever they pick.
  const sign = (delivered: string | null) => mintToken({
    user_id: userId, text_hash: hashText(text), delivered_text: delivered,
    change_summary: t.change_summary, heated: t.heated, safety: t.safety,
  });
  return {
    delivered_text: t.delivered_text, change_summary: t.change_summary, heated: t.heated, safety: t.safety,
    advice: t.advice,
    preview_token: sign(t.delivered_text),
    alternatives: t.safety ? [] : t.alternatives.map((text) => ({ text, preview_token: sign(text) })),
  };
}

type Row = typeof messages.$inferSelect;

/** One serializer: the sender sees their original; a recipient sees it only if shared and they have paid access. */
export function serialize(m: Row, viewer: User) {
  const mine = m.senderId === viewer.id;
  return {
    id: m.id,
    sender_id: m.senderId,
    mine,
    text: m.deliveredText,
    mode: m.mode,
    change_summary: mine ? m.changeSummary : null,
    heated: m.heated,
    original_shared: m.originalShared,
    original_text: mine || (m.originalShared && hasPaidAccess(viewer)) ? m.originalText : null,
    visible_at: m.visibleAt.toISOString(),
    created_at: m.createdAt.toISOString(),
  };
}

export const sendSchema = z.object({
  text: z.string(),
  mode: z.enum(["translated", "as_written"]),
  preview_token: z.string().optional(),
}).strict();

export async function send(db: DB, userId: string, input: z.infer<typeof sendSchema>) {
  const u = await requireReady(db, userId);
  const text = textSchema.parse(input.text);
  const c = await activeCouple(db, userId);
  if (!c) throw new ApiError(404, "not_paired", "Connect with your partner before sending.");
  let delivered = text, summary: string | null = null, heated = false, nonce: string | null = null;
  const paid = hasPaidAccess(u);
  if (input.mode === "translated") {
    if (!input.preview_token) throw new ApiError(400, "invalid_token", "Preview the message before sending it translated.");
    const claims = verifyToken(input.preview_token, userId, text);
    if (claims.safety || !claims.delivered_text) {
      throw new ApiError(422, "safety_requires_as_written", "This message can't be softened. You can edit it or send it as written.");
    }
    delivered = claims.delivered_text; summary = claims.change_summary; heated = claims.heated; nonce = claims.nonce;
  }
  const charge = input.mode === "translated" && !paid;
  try {
    const row = await db.transaction(async (tx) => {
      await tx.execute(sql`set local lock_timeout = '1s'`);
      if (charge) {
        const ok = await tx.update(users).set({ freeTranslationsUsed: sql`${users.freeTranslationsUsed} + 1` })
          .where(and(eq(users.id, userId), lt(users.freeTranslationsUsed, FREE_TRANSLATIONS))).returning({ used: users.freeTranslationsUsed });
        if (!ok.length) {
          throw new ApiError(402, "free_translations_used_up",
            `You've used your ${FREE_TRANSLATIONS} free translated messages. Upgrade, share it instead, or send as written.`, { limit: FREE_TRANSLATIONS, used: FREE_TRANSLATIONS });
        }
      }
      // Last statement: visible_at from the clock at insert time, ms precision so cursors round-trip exactly.
      const [m] = await tx.insert(messages).values({
        coupleId: c.coupleId, senderId: userId, originalText: text, deliveredText: delivered, mode: input.mode,
        changeSummary: summary, heated, chargedFreeSlot: charge, previewNonce: nonce,
        visibleAt: sql`date_trunc('milliseconds', clock_timestamp() + make_interval(secs => ${undoWindowSeconds()}))`,
      }).returning();
      return m;
    });
    await logEvent(db, userId, "message_sent", { mode: input.mode, heated, translated: input.mode === "translated" }, c.coupleId);
    return serialize(row, u);
  } catch (e) {
    const code = pgCode(e);
    if (code === "23505") throw new ApiError(409, "already_sent", "This preview was already sent.");
    if (code === "55P03") throw new ApiError(503, "busy", "Sending is busy right now. Try again in a moment.", { retryable: true });
    throw e;
  }
}

export async function undo(db: DB, userId: string, id: string) {
  await requireReady(db, userId);
  if (!z.uuid().safeParse(id).success) throw new ApiError(404, "not_found", "No such message.");
  const result = await db.transaction(async (tx) => {
    const [m] = await tx.select().from(messages).where(eq(messages.id, id)).for("update");
    if (!m || m.senderId !== userId) throw new ApiError(404, "not_found", "No such message.");
    const del = await tx.delete(messages)
      .where(and(eq(messages.id, id), sql`clock_timestamp() < ${messages.visibleAt} - interval '1 second'`)).returning();
    if (!del.length) throw new ApiError(409, "undo_window_closed", "This message was already delivered.");
    if (m.chargedFreeSlot) {
      await tx.update(users).set({ freeTranslationsUsed: sql`${users.freeTranslationsUsed} - 1` }).where(eq(users.id, userId));
    }
    return m;
  });
  await logEvent(db, userId, "message_undone", {}, result.coupleId);
  return { ok: true, text: result.originalText, mode: result.mode, refunded: result.chargedFreeSlot };
}

export function encodeCursor(visibleAt: Date, id: string) {
  return Buffer.from(JSON.stringify([visibleAt.toISOString(), id])).toString("base64url");
}

function decodeCursor(cursor: string): [string, string] {
  try {
    const [t, id] = JSON.parse(Buffer.from(cursor, "base64url").toString()) as [string, string];
    if (Number.isNaN(Date.parse(t)) || !z.uuid().safeParse(id).success) throw 0;
    return [t, id];
  } catch {
    throw new ApiError(400, "invalid_cursor", "This cursor isn't valid. Pass back next_cursor unchanged, or omit it.");
  }
}

export async function list(db: DB, userId: string, opts: { couple_id?: string | null; cursor?: string | null }) {
  const u = await requireReady(db, userId);
  let coupleId: string;
  if (opts.couple_id) {
    const [m] = z.uuid().safeParse(opts.couple_id).success
      ? await db.select().from(coupleMembers).where(and(eq(coupleMembers.coupleId, opts.couple_id), eq(coupleMembers.userId, userId)))
      : [];
    if (!m) throw new ApiError(404, "not_found", "No such conversation.");
    coupleId = opts.couple_id;
  } else {
    const c = await activeCouple(db, userId);
    if (!c) throw new ApiError(404, "not_paired", "You're not connected with anyone yet.");
    coupleId = c.coupleId;
  }
  const after = opts.cursor ? decodeCursor(opts.cursor) : null;
  const visible = await db.select().from(messages).where(and(
    eq(messages.coupleId, coupleId),
    sql`${messages.visibleAt} <= now()`,
    after ? sql`(${messages.visibleAt}, ${messages.id}) > (${after[0]}::timestamptz, ${after[1]}::uuid)` : undefined,
  )).orderBy(asc(messages.visibleAt), asc(messages.id)).limit(200);
  const pending = await db.select().from(messages).where(and(
    eq(messages.coupleId, coupleId), eq(messages.senderId, userId), gt(messages.visibleAt, sql`now()`),
  )).orderBy(asc(messages.visibleAt));
  const [{ now }] = await db.select({ now: sql<string>`now()` }).from(users).where(eq(users.id, userId));
  const last = visible.at(-1);
  return {
    couple_id: coupleId,
    messages: visible.map((m) => serialize(m, u)),
    pending: pending.map((m) => serialize(m, u)),
    server_now: new Date(now).toISOString(),
    next_cursor: last ? encodeCursor(last.visibleAt, last.id) : (opts.cursor ?? null),
  };
}

export async function shareOriginal(db: DB, userId: string, id: string, shared: boolean) {
  await requireReady(db, userId);
  if (!z.uuid().safeParse(id).success) throw new ApiError(404, "not_found", "No such message.");
  const [m] = await db.update(messages).set({ originalShared: shared })
    .where(and(eq(messages.id, id), eq(messages.senderId, userId))).returning();
  if (!m) throw new ApiError(404, "not_found", "No such message.");
  if (shared) await logEvent(db, userId, "original_shared", {}, m.coupleId);
  return { ok: true, original_shared: shared };
}

export const shareOutSchema = z.object({ text: z.string(), preview_token: z.string() }).strict();

/** Share a softened message outside the app. Free users get FREE_SHARES. */
export async function shareOut(db: DB, userId: string, input: z.infer<typeof shareOutSchema>) {
  const u = await requireReady(db, userId);
  const text = textSchema.parse(input.text);
  const claims = verifyToken(input.preview_token, userId, text);
  if (claims.safety || !claims.delivered_text) {
    throw new ApiError(422, "safety_requires_as_written", "This message can't be softened, so it can't be shared from here.");
  }
  const paid = hasPaidAccess(u);
  if (!paid) {
    const ok = await db.update(users).set({ freeSharesUsed: sql`${users.freeSharesUsed} + 1` })
      .where(and(eq(users.id, userId), lt(users.freeSharesUsed, FREE_SHARES))).returning({ id: users.id });
    if (!ok.length) {
      throw new ApiError(402, "free_shares_used_up", `You've used your ${FREE_SHARES} free shares. Upgrade to share without limits.`, { limit: FREE_SHARES, used: FREE_SHARES });
    }
  }
  const c = await activeCouple(db, userId);
  await logEvent(db, userId, "message_shared_out", { paid }, c?.coupleId);
  return { share_text: claims.delivered_text };
}

export async function coach(db: DB, userId: string, rawText: string) {
  const u = await requireReady(db, userId);
  const text = textSchema.parse(rawText);
  if (!hasPaidAccess(u)) throw new ApiError(403, "upgrade_required", "Coaching is part of the paid plan.");
  await reserveAiCall(db, userId);
  const { coupleId, to } = await recipientFor(db, userId);
  try {
    const out = await getCoach().coach(text, to);
    await logEvent(db, userId, "coach_used", {}, coupleId);
    return out.safety ? { ...out, swaps: [] } : out;
  } catch {
    throw new ApiError(503, "translate_failed", "The coach didn't answer in time. Nothing was stored.", { retryable: true });
  }
}
