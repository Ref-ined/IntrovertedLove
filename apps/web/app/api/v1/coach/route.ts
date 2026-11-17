import { z } from "zod";
import { coach } from "@il/core";
import { body, route } from "@/lib/api";

export const maxDuration = 30;
export const POST = route(async ({ db, who, req }) => coach(db, who.id, (await body(req, z.object({ text: z.string() }).strict())).text));
