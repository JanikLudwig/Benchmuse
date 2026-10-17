import { route, searchParams } from "@/server/api/http";
import { getFolderPath, listFolderContents } from "@/server/services/projects";

/** A folder with its breadcrumb path (root first) and direct contents. */
export const GET = route(async ({ req, ctx, params }) => {
  const path = await getFolderPath(ctx.db, params.id!);
  const contents = await listFolderContents(ctx.db, params.id!, {
    includeArchived: searchParams(req).get("includeArchived") === "true",
  });
  return { folder: path[path.length - 1], path, ...contents };
});
