import { moveBody } from "@/server/api/bodies";
import { parseBody, route } from "@/server/api/http";
import { moveFolder } from "@/server/services/projects";

export const POST = route(async ({ req, ctx, params }) =>
  moveFolder(ctx.db, ctx.actor, params.id!, (await parseBody(req, moveBody)).folderId),
);
