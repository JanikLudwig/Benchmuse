import { route } from "@/server/api/http";
import { getFile } from "@/server/services/files";

export const GET = route(async ({ ctx, params }) => getFile(ctx.db, params.id!));
