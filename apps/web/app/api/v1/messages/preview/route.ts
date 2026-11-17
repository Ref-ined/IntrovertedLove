import { z } from "zod";
import { preview } from "@il/core";
import { body, route } from "@/lib/api";

export const maxDuration = 30;
export const POST = route(async ({ db, who, req }) => preview(db, who.id, (await body(req, z.object({ text: z.string() }).strict())).text));
