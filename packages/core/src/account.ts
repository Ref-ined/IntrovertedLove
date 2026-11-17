import { eq } from "drizzle-orm";
import { z } from "zod";
import type { DB } from "./db/client.ts";
import { questionnaire, users } from "./db/schema.ts";
import { answersSchema, deriveTraits } from "./questionnaire.ts";
import { activeCouple, requireReady } from "./users.ts";
import { unpair } from "./pairing.ts";

export const questionnaireSchema = z.object({ answers: answersSchema, share_traits: z.boolean() }).strict();

export async function saveQuestionnaire(db: DB, userId: string, input: z.infer<typeof questionnaireSchema>) {
  await requireReady(db, userId);
  const traits = deriveTraits(input.answers);
  await db.insert(questionnaire).values({ userId, answers: input.answers, traits })
    .onConflictDoUpdate({ target: questionnaire.userId, set: { answers: input.answers, traits, updatedAt: new Date() } });
  await db.update(users).set({ shareTraits: input.share_traits }).where(eq(users.id, userId));
  return { ok: true, traits_count: traits.length };
}

/**
 * Database half of account deletion: unpair (refunds pending sends), then delete the users row;
 * foreign keys cascade to messages, questionnaire, events and memberships. Idempotent.
 */
export async function deleteAccountData(db: DB, userId: string) {
  const [u] = await db.select({ id: users.id }).from(users).where(eq(users.id, userId));
  if (!u) return;
  if (await activeCouple(db, userId)) {
    try { await unpair(db, userId); } catch { /* age-gated users can't be paired anyway */ }
  }
  await db.delete(users).where(eq(users.id, userId));
}
