import { shareOut, shareOutSchema } from "@il/core";
import { body, route } from "@/lib/api";

export const POST = route(async ({ db, who, req }) => shareOut(db, who.id, await body(req, shareOutSchema)));
