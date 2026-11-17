import { getPairCode } from "@il/core";
import { route } from "@/lib/api";

export const GET = route(({ db, who }) => getPairCode(db, who.id));
