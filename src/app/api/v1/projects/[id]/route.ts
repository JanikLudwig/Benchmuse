import { updateProjectBody } from "@/server/api/bodies";
import { parseBody, route } from "@/server/api/http";
import { getProject, getProjectRootFolder, updateProject } from "@/server/services/projects";

export const GET = route(async ({ ctx, params }) => {
  const project = await getProject(ctx.db, params.id!);
  const rootFolder = await getProjectRootFolder(ctx.db, project.id);
  return { ...project, rootFolderId: rootFolder.id };
});

export const PATCH = route(async ({ req, ctx, params }) =>
  updateProject(ctx.db, ctx.actor, params.id!, await parseBody(req, updateProjectBody)),
);
