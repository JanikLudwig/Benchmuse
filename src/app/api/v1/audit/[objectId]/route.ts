import { route } from "@/server/api/http";
import { listAudit } from "@/server/services/audit";

export const GET = route(async ({ ctx, params }) => ({ items: await listAudit(ctx.db, params.objectId!) }));
