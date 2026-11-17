import { z } from "zod";
import { pair, unpair } from "@il/core";
import { body, route } from "@/lib/api";

export const POST = route(async ({ db, who, req }) => pair(db, who.id, (await body(req, z.object({ code: z.string().min(1).max(32) }).strict())).code));
export const DELETE = route(({ db, who }) => unpair(db, who.id));
