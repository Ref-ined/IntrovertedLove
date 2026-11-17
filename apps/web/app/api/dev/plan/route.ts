import { eq, or } from "drizzle-orm";
import { z } from "zod";
import { ApiError, schema } from "@il/core";
import { devRoute } from "@/lib/dev";

export const POST = devRoute(async (db, req) => {
  const { who, plan } = z.object({ who: z.string().min(1), plan: z.enum(["free", "paid"]) }).parse(await req.json());
  const rows = await db.update(schema.users).set({ plan })
    .where(or(eq(schema.users.email, who), eq(schema.users.id, who))).returning({ id: schema.users.id });
  if (!rows.length) throw new ApiError(404, "not_found", `No user with email or id "${who}".`);
  return { updated: rows.map((r) => r.id), plan };
});
