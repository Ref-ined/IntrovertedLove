import path from "node:path";
import { fileDb, postgresDb } from "../packages/core/src/db/client.ts";

export const DATA_DIR = process.env.PGLITE_DIR ?? path.resolve(import.meta.dirname, "..", ".data");

/** DATABASE_URL when set (production), otherwise the local PGlite directory. */
export async function openDb() {
  const url = process.env.DATABASE_URL;
  return url ? postgresDb(url) : fileDb(DATA_DIR);
}
