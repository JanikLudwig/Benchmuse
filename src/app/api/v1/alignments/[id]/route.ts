import { route } from "@/server/api/http";
import { getAlignmentView } from "@/server/services/alignments";

export const GET = route(async ({ ctx, params }) => getAlignmentView(ctx.db, params.id!));
