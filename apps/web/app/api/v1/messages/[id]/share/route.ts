import { z } from "zod";
import { shareOriginal } from "@il/core";
import { body, route } from "@/lib/api";

export const POST = route(async ({ db, who, req, params }) =>
  shareOriginal(db, who.id, params.id, (await body(req, z.object({ shared: z.boolean() }).strict())).shared));
