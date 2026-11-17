import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ERROR_CODES } from "@il/core";
import { checkEnv } from "../env.ts";
import { drafts } from "../lib/drafts.ts";

const root = path.resolve(import.meta.dirname, "../../..");

describe("docs/ERRORS.md", () => {
  it("has an anchor for every error code, and core uses no undeclared code", () => {
    const doc = fs.readFileSync(path.join(root, "docs/ERRORS.md"), "utf8");
    for (const c of ERROR_CODES) expect(doc, c).toContain(`id="${c}"`);
    const src = fs.readdirSync(path.join(root, "packages/core/src")).filter((f) => f.endsWith(".ts"))
      .map((f) => fs.readFileSync(path.join(root, "packages/core/src", f), "utf8")).join("\n");
    for (const m of src.matchAll(/new ApiError\(\d+, "([a-z_]+)"/g)) expect(ERROR_CODES as readonly string[]).toContain(m[1]);
  });
});

describe("env check", () => {
  const prod = { NODE_ENV: "production", PREVIEW_TOKEN_SECRET: "x".repeat(32), ANTHROPIC_API_KEY: "k", CLERK_SECRET_KEY: "s", NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: "p", DATABASE_URL: "postgres://x" };
  it("passes a complete production config and dev defaults", () => {
    expect(checkEnv(prod as NodeJS.ProcessEnv)).toEqual([]);
    expect(checkEnv({ NODE_ENV: "development", DEV_AUTH: "1" } as NodeJS.ProcessEnv)).toEqual([]);
  });
  it("names each problem without printing values", () => {
    const errs = checkEnv({ ...prod, PREVIEW_TOKEN_SECRET: "short", ANTHROPIC_API_KEY: "", DEV_AUTH: "1", COACH: "fake" } as NodeJS.ProcessEnv);
    expect(errs.join(" ")).toMatch(/PREVIEW_TOKEN_SECRET.*ANTHROPIC_API_KEY.*COACH=fake.*DEV_AUTH/);
    expect(errs.join(" ")).not.toContain("short");
  });
  it("rejects a bad undo window", () => {
    for (const v of ["abc", "1", "2.5"]) expect(checkEnv({ NODE_ENV: "development", UNDO_WINDOW_SECONDS: v } as NodeJS.ProcessEnv)).toHaveLength(1);
  });
});

describe("drafts", () => {
  it("saves, restores and deletes per user", () => {
    const mem = new Map<string, string>();
    const store = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v) };
    const a = drafts(store, "alice"), b = drafts(store, "bob");
    const d = a.save("hello");
    a.save("second");
    expect(a.list().map((x) => x.text)).toEqual(["second", "hello"]);
    expect(b.list()).toEqual([]);
    a.remove(d.id);
    expect(a.list().map((x) => x.text)).toEqual(["second"]);
    expect([...mem.values()].join()).not.toContain("bob");
  });
});
