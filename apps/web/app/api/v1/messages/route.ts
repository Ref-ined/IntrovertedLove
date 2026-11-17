import { list, send, sendSchema } from "@il/core";
import { body, route } from "@/lib/api";

export const GET = route(({ db, who, req }) => {
  const q = new URL(req.url).searchParams;
  return list(db, who.id, { couple_id: q.get("couple_id"), cursor: q.get("cursor") });
});
export const POST = route(async ({ db, who, req }) => send(db, who.id, await body(req, sendSchema)));
