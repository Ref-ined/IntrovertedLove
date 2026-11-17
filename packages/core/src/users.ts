import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import type { DB } from "./db/client.ts";
import { couples, coupleMembers, questionnaire, users } from "./db/schema.ts";
import { FREE_SHARES, FREE_TRANSLATIONS } from "./db/schema.ts";
import { ApiError } from "./errors.ts";
import { hasPaidAccess } from "./access.ts";

export type User = typeof users.$inferSelect;

/** Postgres error code from the driver, unwrapping drizzle's query error. */
export function pgCode(e: unknown): string | undefined {
  const err = e as { code?: string; cause?: { code?: string } };
  return err?.code ?? err?.cause?.code;
}

export async function ensureUser(db: DB, id: string, email?: string | null): Promise<User> {
  await db.insert(users).values({ id, email: email ?? null }).onConflictDoNothing();
  let [u] = await db.select().from(users).where(eq(users.id, id));
  if (email && u.email !== email) [u] = await db.update(users).set({ email }).where(eq(users.id, id)).returning();
  return u;
}

/** The user, past the age gate. GET /me is the only route that skips this. */
export async function requireReady(db: DB, id: string, email?: string | null): Promise<User> {
  const u = await ensureUser(db, id, email);
  if (u.ageBlocked) throw new ApiError(403, "age_blocked", "This account is for people 18 and over.");
  if (!u.birthdate) throw new ApiError(403, "age_required", "Add your birthdate first: POST /api/v1/me/birthdate.");
  return u;
}

export async function activeCouple(db: DB, userId: string) {
  const [m] = await db.select({ coupleId: coupleMembers.coupleId }).from(coupleMembers)
    .where(and(eq(coupleMembers.userId, userId), eq(coupleMembers.active, true)));
  if (!m) return null;
  const [p] = await db.select({ id: users.id, name: users.displayName, email: users.email }).from(coupleMembers)
    .innerJoin(users, eq(users.id, coupleMembers.userId))
    .where(and(eq(coupleMembers.coupleId, m.coupleId), sql`${coupleMembers.userId} <> ${userId}`));
  return { coupleId: m.coupleId, partner: p ?? null };
}

export async function hasQuestionnaire(db: DB, userId: string) {
  const [q] = await db.select({ id: questionnaire.userId }).from(questionnaire).where(eq(questionnaire.userId, userId));
  return !!q;
}

export async function getMe(db: DB, id: string, email?: string | null) {
  const u = await ensureUser(db, id, email);
  const couple = await activeCouple(db, id);
  const paid = hasPaidAccess(u);
  return {
    id: u.id,
    email: u.email,
    display_name: u.displayName,
    timezone: u.timezone,
    plan: u.plan,
    paid,
    birthdate_set: !!u.birthdate,
    age_blocked: u.ageBlocked,
    questionnaire_done: await hasQuestionnaire(db, id),
    share_traits: u.shareTraits,
    free_translations_left: paid ? null : FREE_TRANSLATIONS - u.freeTranslationsUsed,
    free_shares_left: paid ? null : FREE_SHARES - u.freeSharesUsed,
    couple: couple && { id: couple.coupleId, partner: couple.partner && { id: couple.partner.id, name: couple.partner.name ?? couple.partner.email ?? "Your partner" } },
  };
}

export const patchMeSchema = z.object({
  display_name: z.string().trim().min(1).max(60).optional(),
  timezone: z.string().min(1).max(64).optional(),
  share_traits: z.boolean().optional(),
}).strict();

export async function patchMe(db: DB, id: string, input: z.infer<typeof patchMeSchema>) {
  if (input.timezone) {
    try { new Intl.DateTimeFormat("en", { timeZone: input.timezone }); } catch {
      throw new ApiError(400, "invalid_input", `"${input.timezone}" isn't a time zone.`, { fields: [{ path: "timezone", message: "unknown" }] });
    }
  }
  await ensureUser(db, id);
  await db.update(users).set({
    ...(input.display_name !== undefined && { displayName: input.display_name }),
    ...(input.timezone !== undefined && { timezone: input.timezone }),
    ...(input.share_traits !== undefined && { shareTraits: input.share_traits }),
  }).where(eq(users.id, id));
  return getMe(db, id);
}

export const birthdateSchema = z.object({ birthdate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }).strict();

export function ageOn(birth: string, today = new Date()): number {
  const [y, m, d] = birth.split("-").map(Number);
  let age = today.getUTCFullYear() - y;
  if (today.getUTCMonth() + 1 < m || (today.getUTCMonth() + 1 === m && today.getUTCDate() < d)) age--;
  return age;
}

export async function setBirthdate(db: DB, id: string, birthdate: string, today = new Date()) {
  const u = await ensureUser(db, id);
  if (u.ageBlocked) throw new ApiError(403, "age_blocked", "This account is for people 18 and over.");
  if (u.birthdate) return getMe(db, id);
  const date = new Date(`${birthdate}T00:00:00Z`);
  if (Number.isNaN(date.getTime()) || date > today || date.toISOString().slice(0, 10) !== birthdate) {
    throw new ApiError(400, "invalid_input", `"${birthdate}" isn't a valid past date.`, { fields: [{ path: "birthdate", message: "invalid" }] });
  }
  if (ageOn(birthdate, today) < 18) {
    await db.update(users).set({ ageBlocked: true }).where(eq(users.id, id));
    throw new ApiError(403, "age_blocked", "This account is for people 18 and over.");
  }
  await db.update(users).set({ birthdate }).where(eq(users.id, id));
  return getMe(db, id);
}

export async function listCouples(db: DB, id: string) {
  await requireReady(db, id);
  const mine = await db.select({ id: couples.id, createdAt: couples.createdAt, endedAt: couples.endedAt })
    .from(coupleMembers).innerJoin(couples, eq(couples.id, coupleMembers.coupleId)).where(eq(coupleMembers.userId, id));
  const out = [];
  for (const c of mine) {
    const [p] = await db.select({ name: users.displayName, email: users.email }).from(coupleMembers)
      .innerJoin(users, eq(users.id, coupleMembers.userId))
      .where(and(eq(coupleMembers.coupleId, c.id), sql`${coupleMembers.userId} <> ${id}`));
    out.push({ id: c.id, partner_name: p?.name ?? p?.email ?? "Former partner", created_at: c.createdAt, ended_at: c.endedAt, active: !c.endedAt });
  }
  return { couples: out };
}
