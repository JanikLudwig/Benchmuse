import { createFolderBody } from "@/server/api/bodies";
import { parseBody, route } from "@/server/api/http";
import { createFolder } from "@/server/services/projects";

export const POST = route(
  async ({ req, ctx }) => createFolder(ctx.db, ctx.actor, await parseBody(req, createFolderBody)),
  { status: 201 },
);
