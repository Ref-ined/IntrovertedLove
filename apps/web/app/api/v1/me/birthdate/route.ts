import { birthdateSchema, setBirthdate } from "@il/core";
import { body, route } from "@/lib/api";

export const POST = route(async ({ db, who, req }) => setBirthdate(db, who.id, (await body(req, birthdateSchema)).birthdate));
