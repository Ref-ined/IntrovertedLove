import { openDb } from "./db.ts";

const d = await openDb();
try {
  await d.migrate();
  console.log(process.env.DATABASE_URL ? "Migrated DATABASE_URL." : "Migrated ./.data.");
} catch (e) {
  console.error("Migration failed. Each migration file runs in its own transaction, so fix it and run again.\n", e);
  process.exitCode = 1;
} finally {
  await d.close();
}
