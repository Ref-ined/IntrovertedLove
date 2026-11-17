import { sql } from "drizzle-orm";
import { z } from "zod";
import type { DB } from "./db/client.ts";
import { events, EVENT_NAMES } from "./db/schema.ts";

type EventName = (typeof EVENT_NAMES)[number];

export async function logEvent(db: DB, userId: string, name: EventName, props: Record<string, unknown> = {}, coupleId?: string | null) {
  await db.insert(events).values({ userId, name, props, coupleId: coupleId ?? null });
}

/** The only events a client may send; props are closed so message text can never land here. */
export const clientEventSchema = z.discriminatedUnion("name", [
  z.object({ name: z.literal("breath_step"), props: z.object({ choice: z.enum(["send", "edit", "later"]) }).strict() }).strict(),
  z.object({ name: z.literal("invite_copied"), props: z.object({}).strict().default({}) }).strict(),
  z.object({ name: z.literal("invite_opened"), props: z.object({}).strict().default({}) }).strict(),
  z.object({ name: z.literal("upgrade_clicked"), props: z.object({ feature: z.enum(["coach", "original", "translation", "share"]) }).strict() }).strict(),
]);

function rows<T>(r: unknown): T[] {
  return (Array.isArray(r) ? r : (r as { rows: T[] }).rows) as T[];
}

/** Counts per user plus the M1 metric: weekly active couples where both partners sent a message. */
export async function eventReport(db: DB) {
  const perUser = rows<{ user_id: string; name: string; n: number }>(await db.execute(
    sql`select user_id, name, count(*)::int as n from events group by user_id, name order by user_id, name`));
  const weekly = rows<{ n: number }>(await db.execute(sql`
    select count(*)::int as n from (
      select couple_id from messages
      where created_at > now() - interval '7 days'
      group by couple_id having count(distinct sender_id) = 2
    ) c`));
  return { per_user: perUser, weekly_active_couples: weekly[0]?.n ?? 0 };
}
