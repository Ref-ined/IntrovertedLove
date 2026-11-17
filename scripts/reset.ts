import fs from "node:fs";
import { execSync } from "node:child_process";
import { acquireDataLock } from "../packages/core/src/db/client.ts";
import { DATA_DIR } from "./db.ts";

if (fs.existsSync(DATA_DIR)) {
  acquireDataLock(DATA_DIR)(); // refuses while a dev server holds it; then releases
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
}
execSync("npm run seed", { stdio: "inherit" });
