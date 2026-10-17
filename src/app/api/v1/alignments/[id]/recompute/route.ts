import { parseBody, route } from "@/server/api/http";
import { recomputeAlignmentBody } from "@/server/api/sequenceBodies";
import { recomputeAlignment } from "@/server/services/alignments";

export const POST = route(async ({ req, ctx, params }) =>
  recomputeAlignment(ctx.db, ctx.actor, params.id!, await parseBody(req, recomputeAlignmentBody)),
);
