import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { drizzle as drizzlePglite } from "drizzle-orm/pglite";
import { migrate as migratePglite } from "drizzle-orm/pglite/migrator";
import { drizzle as drizzlePg } from "drizzle-orm/postgres-js";
import { migrate as migratePg } from "drizzle-orm/postgres-js/migrator";
import type { PgDatabase } from "drizzle-orm/pg-core";
import postgres from "postgres";
import * as schema from "./schema.ts";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type DB = PgDatabase<any, typeof schema>;

export const MIGRATIONS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../migrations");

function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === "EPERM"; }
}

// One process per ./.data: a stale lock (dead pid) is removed, a live one stops the opener.
export function acquireDataLock(dir: string) {
  fs.mkdirSync(dir, { recursive: true });
  const lock = path.join(dir, ".lock");
  if (fs.existsSync(lock)) {
    const pid = Number(fs.readFileSync(lock, "utf8"));
    if (pid && pid !== process.pid && pidAlive(pid)) {
      throw new Error(`${dir} is in use by pid ${pid} (another dev server or script). Stop that process and try again.`);
    }
  }
  fs.writeFileSync(lock, String(process.pid));
  const release = () => { try { if (Number(fs.readFileSync(lock, "utf8")) === process.pid) fs.rmSync(lock); } catch { /* gone */ } };
  process.once("exit", release);
  return release;
}

/** Fresh in-memory database with migrations applied (tests). */
export async function memoryDb(): Promise<{ db: DB; close: () => Promise<void> }> {
  const client = new PGlite();
  const db = drizzlePglite(client, { schema }) as unknown as DB;
  await migratePglite(db as never, { migrationsFolder: MIGRATIONS_DIR });
  return { db, close: () => client.close() };
}

/** Postgres via DATABASE_URL (production pooler, CI race tests, admin scripts). */
export function postgresDb(url: string, opts: { max?: number } = {}) {
  const client = postgres(url, { prepare: false, max: opts.max ?? 1 });
  const db = drizzlePg(client, { schema }) as unknown as DB;
  return { db, client, migrate: () => migratePg(db as never, { migrationsFolder: MIGRATIONS_DIR }), close: () => client.end() };
}

/** File PGlite under dataDir (local dev). */
export async function fileDb(dataDir: string) {
  const release = acquireDataLock(dataDir);
  const client = new PGlite(dataDir);
  const db = drizzlePglite(client, { schema }) as unknown as DB;
  return {
    db,
    migrate: () => migratePglite(db as never, { migrationsFolder: MIGRATIONS_DIR }),
    close: async () => { await client.close(); release(); },
  };
}

const g = globalThis as unknown as { __ilDb?: Promise<DB> };

/** The app's database, opened lazily on first use and shared across hot reloads. */
export function getDb(): Promise<DB> {
  g.__ilDb ??= (async () => {
    const url = process.env.DATABASE_URL;
    if (url) return postgresDb(url).db;
    return (await fileDb(process.env.PGLITE_DIR ?? path.resolve(process.cwd(), findRoot(), ".data"))).db;
  })();
  return g.__ilDb;
}

// Next runs from apps/web; the data dir lives at the repo root.
function findRoot(): string {
  let dir = process.cwd();
  for (let i = 0; i < 4; i++) {
    if (fs.existsSync(path.join(dir, "drizzle.config.ts"))) return dir;
    dir = path.dirname(dir);
  }
  return process.cwd();
}
