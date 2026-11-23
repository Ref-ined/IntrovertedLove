import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import type { DB } from "../src/db/client.ts";
import {
  coach, deleteAccountData, getMe, list, listCouples, pair, getPairCode, preview, reserveAiCall, schema, send, setBirthdate,
  shareOriginal, shareOut, undo, unpair, mintToken, hashText, setCoachForTests, fakeCoach, ensureUser, eventReport,
} from "../src/index.ts";
import { couple, expectApiError, makeVisible, onboarded, openDb, reset } from "./helpers.ts";

let db: DB;
let close: () => Promise<void>;
beforeAll(async () => ({ db, close } = await openDb()));
afterAll(() => close());
// The undo tests need a window; the app default is 0 (no undo).
beforeEach(async () => { await reset(db); setCoachForTests(fakeCoach); process.env.UNDO_WINDOW_SECONDS = "10"; });

const token = (user: string, text: string, over: Partial<{ safety: boolean; delivered_text: string | null }> = {}) =>
  mintToken({ user_id: user, text_hash: hashText(text), delivered_text: "soft " + text, change_summary: "softer", heated: false, safety: false, ...over });

const user = async (id: string) => (await db.select().from(schema.users).where(eq(schema.users.id, id)))[0];

describe("age gate", () => {
  it("blocks under 18 for good and gates other routes until a birthdate is set", async () => {
    await ensureUser(db, "kid");
    await expectApiError(preview(db, "kid", "hi"), 403, "age_required");
    expect((await getMe(db, "kid")).birthdate_set).toBe(false);
    await expectApiError(setBirthdate(db, "kid", "2015-01-01"), 403, "age_blocked");
    await expectApiError(setBirthdate(db, "kid", "1990-01-01"), 403, "age_blocked");
    await expectApiError(getPairCode(db, "kid"), 403, "age_blocked");
  });
  it("turns 18 on the birthday, not the day after", async () => {
    await ensureUser(db, "a");
    await setBirthdate(db, "a", "2008-11-17", new Date("2026-11-17T12:00:00Z"));
    expect((await getMe(db, "a")).birthdate_set).toBe(true);
  });
});

describe("pairing", () => {
  it("pairs once, rotates the used code and refuses a second couple", async () => {
    const c = await couple(db);
    expect(c.couple_id).toBeTruthy();
    await onboarded(db, "carol");
    const { code } = await getPairCode(db, "carol");
    await expectApiError(pair(db, "alice", code), 409, "already_paired");
    const bobCode = (await getPairCode(db, "bob")).code;
    await expectApiError(pair(db, "carol", bobCode), 409, "partner_unavailable");
  });
  it("own code, unknown code and missing questionnaire", async () => {
    await onboarded(db, "a");
    const { code } = await getPairCode(db, "a");
    await expectApiError(pair(db, "a", code), 400, "own_code");
    await expectApiError(pair(db, "a", "ZZZZZZZZZZ"), 410, "code_expired");
    await ensureUser(db, "b"); await setBirthdate(db, "b", "1990-01-01");
    await expectApiError(pair(db, "b", code), 403, "questionnaire_required");
  });
  it("the 11th attempt in an hour gets 429 with retry_after", async () => {
    await onboarded(db, "a");
    for (let i = 0; i < 10; i++) await expectApiError(pair(db, "a", "ZZZZZZZZZZ"), 410, "code_expired");
    const e = await expectApiError(pair(db, "a", "ZZZZZZZZZZ"), 429, "rate_limited") as { extra: { retry_after: number } };
    expect(e.extra.retry_after).toBeGreaterThan(0);
  });
  it("unpair keeps history readable, deletes and refunds pending, and lists the old couple", async () => {
    const { couple_id } = await couple(db);
    const t = "you never call";
    await send(db, "alice", { text: "visible one", mode: "as_written" });
    await makeVisible(db);
    await send(db, "alice", { text: t, mode: "translated", preview_token: token("alice", t) });
    expect((await user("alice")).freeTranslationsUsed).toBe(1);
    await unpair(db, "alice");
    expect((await user("alice")).freeTranslationsUsed).toBe(0);
    await expectApiError(list(db, "alice", {}), 404, "not_paired");
    const old = await list(db, "bob", { couple_id });
    expect(old.messages.map((m) => m.text)).toEqual(["visible one"]);
    expect((await listCouples(db, "alice")).couples[0].active).toBe(false);
  });
});

describe("free translations and previews", () => {
  it("a free user gets 10 translated sends, then 402", async () => {
    await couple(db);
    for (let i = 0; i < 10; i++) await send(db, "alice", { text: `m${i}`, mode: "translated", preview_token: token("alice", `m${i}`) });
    await expectApiError(send(db, "alice", { text: "m10", mode: "translated", preview_token: token("alice", "m10") }), 402, "free_translations_used_up");
    await send(db, "alice", { text: "plain", mode: "as_written" }); // as written always works
  });
  it("paired previews cap at 30, unpaired at 5", async () => {
    await onboarded(db, "solo");
    for (let i = 0; i < 5; i++) await preview(db, "solo", "hello");
    const e = await expectApiError(preview(db, "solo", "hello"), 402, "free_previews_used_up") as { extra: { limit: number } };
    expect(e.extra.limit).toBe(5);
    await reset(db); await couple(db);
    await db.update(schema.users).set({ freePreviewsUsed: 29 }).where(eq(schema.users.id, "alice"));
    await preview(db, "alice", "hello");
    await expectApiError(preview(db, "alice", "hello"), 402, "free_previews_used_up");
  });
  it("an AI failure releases the preview and logs translation_failed", async () => {
    await couple(db);
    setCoachForTests({ ...fakeCoach, translate: async () => { throw new Error("boom"); } });
    await expectApiError(preview(db, "alice", "hello"), 503, "translate_failed");
    expect((await user("alice")).freePreviewsUsed).toBe(0);
    expect((await eventReport(db)).per_user.some((r) => r.name === "translation_failed")).toBe(true);
  });
  it("with sends used up but shares left, preview still works", async () => {
    await couple(db);
    await db.update(schema.users).set({ freeTranslationsUsed: 10 }).where(eq(schema.users.id, "alice"));
    await preview(db, "alice", "hello");
    await db.update(schema.users).set({ freeSharesUsed: 5 }).where(eq(schema.users.id, "alice"));
    await expectApiError(preview(db, "alice", "hello"), 402, "free_translations_used_up");
  });
  it("the 121st AI call in an hour gets 429", async () => {
    await onboarded(db, "a");
    await db.update(schema.users).set({ aiWindowStart: sql`now()`, aiCallsInWindow: 120 }).where(eq(schema.users.id, "a"));
    await expectApiError(reserveAiCall(db, "a"), 429, "ai_rate_limited");
    await db.update(schema.users).set({ aiWindowStart: sql`now() - interval '2 hours'` }).where(eq(schema.users.id, "a"));
    await reserveAiCall(db, "a");
    expect((await user("a")).aiCallsInWindow).toBe(1);
  });
});

describe("sending, tokens and safety", () => {
  it("rejects replays, tampering and safety tokens; heated comes from the token", async () => {
    await couple(db);
    const tk = mintToken({ user_id: "alice", text_hash: hashText("hi"), delivered_text: "soft hi", change_summary: null, heated: true, safety: false });
    const m = await send(db, "alice", { text: "hi", mode: "translated", preview_token: tk });
    expect(m.heated).toBe(true);
    expect(m.text).toBe("soft hi");
    await expectApiError(send(db, "alice", { text: "hi", mode: "translated", preview_token: tk }), 409, "already_sent");
    await expectApiError(send(db, "alice", { text: "other", mode: "translated", preview_token: tk }), 400, "invalid_token");
    await expectApiError(send(db, "alice", { text: "hi", mode: "translated", preview_token: tk.slice(0, -2) + "xx" }), 400, "invalid_token");
    await expectApiError(send(db, "alice", { text: "x", mode: "translated", preview_token: token("alice", "x", { safety: true, delivered_text: null }) }), 422, "safety_requires_as_written");
    expect((await user("alice")).freeTranslationsUsed).toBe(1); // the failed replay didn't charge
  });
  it("fake coach flags threats as safety with no softened text", async () => {
    await couple(db);
    const p = await preview(db, "alice", "do it or else");
    expect(p.safety).toBe(true);
    expect(p.delivered_text).toBeNull();
  });
});

describe("undo and the cursor", () => {
  it("hides until visible, undo refunds and the same token re-sends; 409 after the window, 404 for others", async () => {
    await couple(db);
    const tk = token("alice", "sorry");
    const m = await send(db, "alice", { text: "sorry", mode: "translated", preview_token: tk });
    expect((await list(db, "bob", {})).messages).toHaveLength(0);
    expect((await list(db, "alice", {})).pending).toHaveLength(1);
    await expectApiError(undo(db, "bob", m.id), 404, "not_found");
    const u = await undo(db, "alice", m.id);
    expect(u.refunded).toBe(true);
    expect((await user("alice")).freeTranslationsUsed).toBe(0);
    const again = await send(db, "alice", { text: "sorry", mode: "translated", preview_token: tk });
    await makeVisible(db);
    expect((await list(db, "bob", {})).messages.map((x) => x.id)).toEqual([again.id]);
    await expectApiError(undo(db, "alice", again.id), 409, "undo_window_closed");
  });
  it("refunds nothing for a paid send undone after switching to free", async () => {
    await couple(db, "alice", "bob", { aPaid: true });
    const m = await send(db, "alice", { text: "x", mode: "translated", preview_token: token("alice", "x") });
    await db.update(schema.users).set({ plan: "free" }).where(eq(schema.users.id, "alice"));
    expect((await undo(db, "alice", m.id)).refunded).toBe(false);
    expect((await user("alice")).freeTranslationsUsed).toBe(0);
  });
  it("a message that becomes visible later is not skipped by the cursor", async () => {
    await couple(db);
    await send(db, "alice", { text: "first", mode: "as_written" });
    await db.execute(sql`update messages set visible_at = now() + interval '1 hour'`); // still pending
    await send(db, "bob", { text: "second", mode: "as_written" });
    await db.execute(sql`update messages set visible_at = now() - interval '1 second' where original_text = 'second'`);
    const page1 = await list(db, "alice", {});
    expect(page1.messages.map((m) => m.text)).toEqual(["second"]);
    expect(page1.pending.map((m) => m.text)).toEqual(["first"]);
    // its window ends now: still after "second", as real visible_at values always are
    await db.execute(sql`update messages set visible_at = now() - interval '100 milliseconds' where original_text = 'first'`);
    const page2 = await list(db, "bob", { cursor: page1.next_cursor });
    expect(page2.messages.map((m) => m.text)).toEqual(["first"]);
    await expectApiError(list(db, "bob", { cursor: "garbage" }), 400, "invalid_cursor");
  });
  it("respects UNDO_WINDOW_SECONDS", async () => {
    await couple(db);
    process.env.UNDO_WINDOW_SECONDS = "30";
    await send(db, "alice", { text: "x", mode: "as_written" });
    delete process.env.UNDO_WINDOW_SECONDS;
    const [m] = await db.select().from(schema.messages);
    expect(m.visibleAt.getTime() - m.createdAt.getTime()).toBeGreaterThan(29_000);
  });
  it("delivers at once when no window is set", async () => {
    await couple(db);
    delete process.env.UNDO_WINDOW_SECONDS;
    const m = await send(db, "alice", { text: "now", mode: "as_written" });
    expect((await list(db, "bob", {})).messages.map((x) => x.id)).toEqual([m.id]);
    await expectApiError(undo(db, "alice", m.id), 409, "undo_window_closed");
  });
});

describe("originals, sharing out and coaching", () => {
  it("serializer: unshared original never reaches the recipient; shared reaches only a paid recipient", async () => {
    await couple(db);
    const m = await send(db, "alice", { text: "raw", mode: "translated", preview_token: token("alice", "raw") });
    await makeVisible(db);
    expect((await list(db, "bob", {})).messages[0].original_text).toBeNull();
    await shareOriginal(db, "alice", m.id, true);
    expect((await list(db, "bob", {})).messages[0].original_text).toBeNull(); // bob is free
    await db.update(schema.users).set({ plan: "paid" }).where(eq(schema.users.id, "bob"));
    expect((await list(db, "bob", {})).messages[0].original_text).toBe("raw");
    expect((await list(db, "alice", {})).messages[0].original_text).toBe("raw");
    await expectApiError(shareOriginal(db, "bob", m.id, true), 404, "not_found");
  });
  it("share-out: 5 free, then 402; unpaired works; safety refused; paid unlimited", async () => {
    await onboarded(db, "solo");
    for (let i = 0; i < 5; i++) expect((await shareOut(db, "solo", { text: "hey", preview_token: token("solo", "hey") })).share_text).toBe("soft hey");
    await expectApiError(shareOut(db, "solo", { text: "hey", preview_token: token("solo", "hey") }), 402, "free_shares_used_up");
    await expectApiError(shareOut(db, "solo", { text: "x", preview_token: token("solo", "x", { safety: true, delivered_text: null }) }), 422, "safety_requires_as_written");
    await onboarded(db, "rich", { paid: true });
    for (let i = 0; i < 7; i++) await shareOut(db, "rich", { text: "hey", preview_token: token("rich", "hey") });
    expect(await db.$count(schema.messages)).toBe(0);
  });
  it("coaching is paid-only and says general advice when traits aren't shared", async () => {
    await couple(db, "alice", "bob", { aPaid: true });
    await expectApiError(coach(db, "bob", "hi"), 403, "upgrade_required");
    expect((await coach(db, "alice", "you always forget")).landing).toContain("bob");
    await db.update(schema.users).set({ shareTraits: false }).where(eq(schema.users.id, "bob"));
    expect((await coach(db, "alice", "hi")).landing).toContain("general advice");
  });
});

describe("versions and advice", () => {
  it("the sender gets alternatives they can send, and advice that never reaches the recipient", async () => {
    await couple(db);
    const p = await preview(db, "alice", "You never call me!!");
    expect(p.advice).toBeTruthy();
    expect(p.alternatives.length).toBeGreaterThan(0);
    const alt = p.alternatives[0];
    const m = await send(db, "alice", { text: "You never call me!!", mode: "translated", preview_token: alt.preview_token });
    expect(m.text).toBe(alt.text);
    await makeVisible(db);
    const seen = JSON.stringify((await list(db, "bob", {})).messages);
    expect(seen).not.toContain(p.advice!);
  });
});

describe("whose answers shape a message", () => {
  it("Alice → Bob uses Bob's answers as the recipient and Alice's as her own voice, and vice versa", async () => {
    await couple(db);
    const { saveQuestionnaire } = await import("../src/account.ts");
    const { questions } = await import("../src/questionnaire.ts");
    const second = Object.fromEntries(questions.map((q) => [q.id, q.multiple ? [q.options[1].value] : q.options[1].value]));
    await saveQuestionnaire(db, "bob", { answers: second, share_traits: true }); // bob answers differently from alice
    const seen: { to: string[]; from: string[]; toName: string; fromName: string }[] = [];
    setCoachForTests({ ...fakeCoach, translate: async (text, to, from) => { seen.push({ to: to.traits, from: from.traits, toName: to.name, fromName: from.name }); return fakeCoach.translate(text, to, from); } });
    await preview(db, "alice", "hi");
    await preview(db, "bob", "hi");
    const [a, b] = seen;
    expect([a.fromName, a.toName, b.fromName, b.toName]).toEqual(["alice", "bob", "bob", "alice"]);
    expect(a.from).toEqual(b.to); // alice's answers: her voice when she sends, her preferences when she receives
    expect(a.to).toEqual(b.from);
    expect(a.from).not.toEqual(a.to);
  });
  it("a recipient who turned sharing off gets general advice; the sender's voice is still used", async () => {
    await couple(db);
    await db.update(schema.users).set({ shareTraits: false }).where(eq(schema.users.id, "bob"));
    let got: { shared: boolean; from: number } | undefined;
    setCoachForTests({ ...fakeCoach, translate: async (text, to, from) => { got = { shared: to.shared, from: from.traits.length }; return fakeCoach.translate(text, to, from); } });
    await preview(db, "alice", "hi");
    expect(got).toEqual({ shared: false, from: 18 });
  });
});

describe("account deletion", () => {
  it("removes the user and cascades; the partner's own messages stay; re-signup with the same email works", async () => {
    await couple(db);
    await send(db, "alice", { text: "a", mode: "as_written" });
    await send(db, "bob", { text: "b", mode: "as_written" });
    await makeVisible(db);
    await deleteAccountData(db, "alice");
    await deleteAccountData(db, "alice"); // idempotent
    expect(await user("alice")).toBeUndefined();
    const left = await db.select().from(schema.messages);
    expect(left.map((m) => m.originalText)).toEqual(["b"]);
    await ensureUser(db, "alice2", "alice@example.test");
    expect((await getMe(db, "bob")).couple).toBeNull();
  });
});
