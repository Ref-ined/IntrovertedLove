import { eq } from "drizzle-orm";
import { openDb } from "./db.ts";
import { ensureUser, getPairCode, pair, saveQuestionnaire, schema, setBirthdate, activeCouple } from "../packages/core/src/index.ts";
import { questions } from "../packages/core/src/questionnaire.ts";

if (process.env.DATABASE_URL) {
  console.error("seed is for local development only; unset DATABASE_URL.");
  process.exit(1);
}

const d = await openDb();
const db = d.db;
const pick = (i: number) => Object.fromEntries(questions.map((q) => [q.id, q.multiple ? [q.options[i % q.options.length].value] : q.options[i % q.options.length].value]));

for (const [id, name, i, plan] of [["alice", "Alice", 1, "free"], ["bob", "Bob", 2, "paid"]] as const) {
  await ensureUser(db, id, `${id}@dev.local`);
  await db.update(schema.users).set({ displayName: name, plan }).where(eq(schema.users.id, id));
  await setBirthdate(db, id, "1994-06-15");
  await saveQuestionnaire(db, id, { answers: pick(i), share_traits: true });
}
if (!(await activeCouple(db, "alice"))) {
  const { code } = await getPairCode(db, "bob");
  await pair(db, "alice", code);
}
await d.close();
console.log("Seeded alice (free) and bob (paid), paired. Open /dev/login?as=alice and /dev/login?as=bob.");
