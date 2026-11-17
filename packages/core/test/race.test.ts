import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { DB } from "../src/db/client.ts";
import { hashText, mintToken, preview, reserveAiCall, schema, send, shareOut, setCoachForTests, fakeCoach, getPairCode, pair } from "../src/index.ts";
import { couple, onboarded, openRaceDb, reset } from "./helpers.ts";

// PGlite runs one query at a time, so races only show on real Postgres (CI sets TEST_DATABASE_URL).
const RACE = !!process.env.TEST_DATABASE_URL;

describe.skipIf(!RACE)("races (TEST_DATABASE_URL not set: skipped)", () => {
  let db: DB; let close: () => Promise<void>;
  beforeAll(async () => { const p = await openRaceDb(); db = p.db; close = p.close; });
  afterAll(() => close?.());
  beforeEach(async () => { await reset(db); setCoachForTests(fakeCoach); });
  const settled = async (ps: Promise<unknown>[]) => (await Promise.allSettled(ps)).filter((r) => r.status === "fulfilled").length;

  it("30 parallel translated sends succeed exactly 10 times", async () => {
    await couple(db);
    const tks = Array.from({ length: 30 }, (_, i) => mintToken({ user_id: "alice", text_hash: hashText(`m${i}`), delivered_text: "s", change_summary: null, heated: false, safety: false }));
    expect(await settled(tks.map((t, i) => send(db, "alice", { text: `m${i}`, mode: "translated", preview_token: t })))).toBe(10);
  });
  it("40 parallel previews reserve exactly 30", async () => {
    await couple(db);
    await settled(Array.from({ length: 40 }, () => preview(db, "alice", "hello")));
    expect((await db.select().from(schema.users).where(eq(schema.users.id, "alice")))[0].freePreviewsUsed).toBe(30);
  });
  it("150 parallel AI calls reserve exactly 120", async () => {
    await onboarded(db, "a");
    expect(await settled(Array.from({ length: 150 }, () => reserveAiCall(db, "a")))).toBe(120);
  });
  it("10 parallel share-outs succeed exactly 5 times", async () => {
    await onboarded(db, "a");
    const t = mintToken({ user_id: "a", text_hash: hashText("hey"), delivered_text: "s", change_summary: null, heated: false, safety: false });
    expect(await settled(Array.from({ length: 10 }, () => shareOut(db, "a", { text: "hey", preview_token: t })))).toBe(5);
  });
  it("crossing pair requests leave each user in at most one couple", async () => {
    for (const u of ["x", "y", "z"]) await onboarded(db, u);
    const [yc, xc] = [(await getPairCode(db, "y")).code, (await getPairCode(db, "x")).code];
    await Promise.allSettled([pair(db, "x", yc), pair(db, "z", xc)]);
    const active = await db.select().from(schema.coupleMembers).where(eq(schema.coupleMembers.userId, "x"));
    expect(active.filter((m) => m.active).length).toBe(1);
  });
});
