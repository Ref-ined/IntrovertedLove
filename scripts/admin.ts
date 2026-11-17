// Production admin from the founder's machine: npm run admin:report | npm run admin:plan -- <email> free|paid
import { eq, or } from "drizzle-orm";
import { postgresDb } from "../packages/core/src/db/client.ts";
import { eventReport, schema } from "../packages/core/src/index.ts";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("Set DATABASE_URL to the production database. (Locally, use npm run report:events / dev:plan.)");
  process.exit(1);
}
console.log(`Target: ${new URL(url).host}`);
const [cmd, who, plan] = process.argv.slice(2);
const d = postgresDb(url);
try {
  if (cmd === "plan") {
    if (!who || !["free", "paid"].includes(plan)) throw new Error("Usage: npm run admin:plan -- <email-or-id> free|paid");
    const rows = await d.db.update(schema.users).set({ plan: plan as "free" | "paid" })
      .where(or(eq(schema.users.email, who), eq(schema.users.id, who))).returning({ id: schema.users.id });
    console.log(rows.length ? `Set ${rows.map((r) => r.id).join(", ")} to ${plan}.` : `No user "${who}".`);
  } else {
    console.log(JSON.stringify(await eventReport(d.db), null, 2));
  }
} catch (e) {
  console.error((e as Error).message);
  process.exitCode = 1;
} finally {
  await d.close();
}
