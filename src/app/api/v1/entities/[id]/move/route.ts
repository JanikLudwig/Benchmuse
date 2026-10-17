import { moveBody } from "@/server/api/bodies";
import { parseBody, route } from "@/server/api/http";
import { moveEntity } from "@/server/services/entities";

export const POST = route(async ({ req, ctx, params }) =>
  moveEntity(ctx.db, ctx.actor, params.id!, (await parseBody(req, moveBody)).folderId),
);
