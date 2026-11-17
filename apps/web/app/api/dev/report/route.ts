import { eventReport } from "@il/core";
import { devRoute } from "@/lib/dev";

export const GET = devRoute((db) => eventReport(db));
