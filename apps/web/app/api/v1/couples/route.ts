import { listCouples } from "@il/core";
import { route } from "@/lib/api";

export const GET = route(({ db, who }) => listCouples(db, who.id));
