import { route } from "@/server/api/http";
import { previewImport } from "@/server/services/importing";

/** Parse an uploaded file and report what would be imported, without writing anything. */
export const GET = route(async ({ ctx, params }) => previewImport(ctx.db, params.id!));
