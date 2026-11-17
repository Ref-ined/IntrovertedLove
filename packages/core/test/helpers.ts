import { sql } from "drizzle-orm";
import { memoryDb, postgresDb, type DB } from "../src/db/client.ts";
import { ensureUser, setBirthdate } from "../src/users.ts";
import { saveQuestionnaire } from "../src/account.ts";
import { questions } from "../src/questionnaire.ts";
import { getPairCode, pair } from "../src/pairing.ts";
import { schema } from "../src/index.ts";
import { eq } from "drizzle-orm";

export const answers = Object.fromEntries(questions.map((q) => [q.id, q.multiple ? [q.options[0].value] : q.options[0].value]));

export async function openDb(): Promise<{ db: DB; close: () => Promise<void> }> {
  return memoryDb();
}

/** Real Postgres for race tests (CI); skipped without TEST_DATABASE_URL. */
export async function openRaceDb() {
  const p = postgresDb(process.env.TEST_DATABASE_URL!, { max: 20 });
  await p.migrate();
  return p;
}

export async function reset(db: DB) {
  await db.execute(sql`truncate users, couples, couple_members, pair_attempts, questionnaire, messages, events cascade`);
}

export async function onboarded(db: DB, id: string, opts: { paid?: boolean; name?: string } = {}) {
  await ensureUser(db, id, `${id}@example.test`);
  await setBirthdate(db, id, "1995-05-05");
  await saveQuestionnaire(db, id, { answers, share_traits: true });
  await db.update(schema.users).set({ displayName: opts.name ?? id, plan: opts.paid ? "paid" : "free" }).where(eq(schema.users.id, id));
}

export async function couple(db: DB, a = "alice", b = "bob", opts: { bPaid?: boolean; aPaid?: boolean } = {}) {
  await onboarded(db, a, { paid: opts.aPaid });
  await onboarded(db, b, { paid: opts.bPaid });
  const { code } = await getPairCode(db, b);
  return pair(db, a, code);
}

export async function makeVisible(db: DB) {
  await db.execute(sql`update messages set visible_at = now() - interval '2 seconds'`);
}

export async function expectApiError(p: Promise<unknown>, status: number, code: string) {
  try {
    await p;
  } catch (e) {
    const err = e as { status?: number; code?: string };
    if (err.status === status && err.code === code) return e;
    throw new Error(`expected ${status} ${code}, got ${err.status} ${err.code}: ${(e as Error).message}`);
  }
  throw new Error(`expected ${status} ${code}, but it succeeded`);
}
