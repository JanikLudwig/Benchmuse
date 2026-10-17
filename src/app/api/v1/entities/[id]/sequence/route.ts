import { parseBody, route, searchParams } from "@/server/api/http";
import { editSequenceBody, originBody } from "@/server/api/sequenceBodies";
import { ValidationError } from "@/server/services/errors";
import { changeOrigin, editSequence, flipSequence } from "@/server/services/sequenceTools";

/** Apply edits to the sequence, moving features with them. */
export const PATCH = route(async ({ req, ctx, params }) =>
  editSequence(ctx.db, ctx.actor, params.id!, await parseBody(req, editSequenceBody)),
);

/** Whole-molecule operations: `?action=set-origin` or `?action=flip`. */
export const POST = route(async ({ req, ctx, params }) => {
  const action = searchParams(req).get("action");
  if (action === "flip") return flipSequence(ctx.db, ctx.actor, params.id!);
  if (action === "set-origin") {
    const { origin } = await parseBody(req, originBody);
    return changeOrigin(ctx.db, ctx.actor, params.id!, origin);
  }
  throw new ValidationError("action must be 'flip' or 'set-origin'");
});
