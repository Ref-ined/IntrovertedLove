import { questions, questionnaireSchema, requireReady, saveQuestionnaire } from "@il/core";
import { body, route } from "@/lib/api";

export const GET = route(async ({ db, who }) => { await requireReady(db, who.id, who.email); return { questions }; });
export const PUT = route(async ({ db, who, req }) => saveQuestionnaire(db, who.id, await body(req, questionnaireSchema)));
