import { undo } from "@il/core";
import { route } from "@/lib/api";

export const DELETE = route(({ db, who, params }) => undo(db, who.id, params.id));
