import { activeCouple, clientEventSchema, logEvent, requireReady } from "@il/core";
import { body, route } from "@/lib/api";

export const POST = route(async ({ db, who, req }) => {
  const e = await body(req, clientEventSchema);
  await requireReady(db, who.id);
  await logEvent(db, who.id, e.name, e.props, (await activeCouple(db, who.id))?.coupleId);
  return { ok: true };
});
