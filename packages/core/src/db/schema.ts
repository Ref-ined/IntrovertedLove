import { sql } from "drizzle-orm";
import {
  boolean, check, date, index, integer, jsonb, pgTable, primaryKey, text, timestamp, uniqueIndex, uuid,
} from "drizzle-orm/pg-core";

export const FREE_TRANSLATIONS = 10;
export const FREE_PREVIEWS = 30;
export const FREE_UNPAIRED_PREVIEWS = 5;
export const FREE_SHARES = 5;
export const AI_CALLS_PER_HOUR = 120;
export const PAIR_ATTEMPTS_PER_HOUR = 10;

export const users = pgTable("users", {
  id: text("id").primaryKey(),
  email: text("email"),
  displayName: text("display_name"),
  birthdate: date("birthdate"),
  timezone: text("timezone").notNull().default("UTC"),
  plan: text("plan", { enum: ["free", "paid"] }).notNull().default("free"),
  freeTranslationsUsed: integer("free_translations_used").notNull().default(0),
  freePreviewsUsed: integer("free_previews_used").notNull().default(0),
  freeSharesUsed: integer("free_shares_used").notNull().default(0),
  pairCode: text("pair_code"),
  pairCodeExpiresAt: timestamp("pair_code_expires_at", { withTimezone: true }),
  shareTraits: boolean("share_traits").notNull().default(true),
  ageBlocked: boolean("age_blocked").notNull().default(false),
  aiWindowStart: timestamp("ai_window_start", { withTimezone: true }),
  aiCallsInWindow: integer("ai_calls_in_window").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("users_pair_code_uq").on(t.pairCode),
  check("free_translations_range", sql`${t.freeTranslationsUsed} between 0 and ${sql.raw(String(FREE_TRANSLATIONS))}`),
  check("free_previews_range", sql`${t.freePreviewsUsed} between 0 and ${sql.raw(String(FREE_PREVIEWS))}`),
  check("free_shares_range", sql`${t.freeSharesUsed} between 0 and ${sql.raw(String(FREE_SHARES))}`),
]);

export const couples = pgTable("couples", {
  id: uuid("id").primaryKey().defaultRandom(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  endedAt: timestamp("ended_at", { withTimezone: true }),
});

export const coupleMembers = pgTable("couple_members", {
  coupleId: uuid("couple_id").notNull().references(() => couples.id, { onDelete: "cascade" }),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  active: boolean("active").notNull().default(true),
}, (t) => [
  primaryKey({ columns: [t.coupleId, t.userId] }),
  uniqueIndex("one_active_couple_per_user").on(t.userId).where(sql`${t.active}`),
]);

export const pairAttempts = pgTable("pair_attempts", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index("pair_attempts_user_at").on(t.userId, t.at)]);

export const questionnaire = pgTable("questionnaire", {
  userId: text("user_id").primaryKey().references(() => users.id, { onDelete: "cascade" }),
  answers: jsonb("answers").notNull(),
  traits: jsonb("traits").$type<string[]>().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const messages = pgTable("messages", {
  id: uuid("id").primaryKey().defaultRandom(),
  coupleId: uuid("couple_id").notNull().references(() => couples.id, { onDelete: "cascade" }),
  senderId: text("sender_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  originalText: text("original_text").notNull(),
  deliveredText: text("delivered_text").notNull(),
  mode: text("mode", { enum: ["translated", "as_written"] }).notNull(),
  changeSummary: text("change_summary"),
  heated: boolean("heated").notNull().default(false),
  originalShared: boolean("original_shared").notNull().default(false),
  chargedFreeSlot: boolean("charged_free_slot").notNull().default(false),
  previewNonce: text("preview_nonce").unique(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  // set by the send SQL (clock_timestamp() + window); no default on purpose
  visibleAt: timestamp("visible_at", { withTimezone: true }).notNull(),
}, (t) => [index("messages_couple_visible").on(t.coupleId, t.visibleAt, t.id)]);

export const EVENT_NAMES = [
  "message_sent", "message_undone", "breath_step", "coach_used", "original_shared", "paired",
  "translation_failed", "invite_copied", "invite_opened", "upgrade_clicked", "message_shared_out",
] as const;

export const events = pgTable("events", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  coupleId: uuid("couple_id"),
  name: text("name", { enum: EVENT_NAMES }).notNull(),
  props: jsonb("props").notNull().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index("events_user_name_at").on(t.userId, t.name, t.createdAt)]);
