import { createProjectBody } from "@/server/api/bodies";
import { parseBody, route, searchParams } from "@/server/api/http";
import { createProject, listProjects } from "@/server/services/projects";

export const GET = route(async ({ req, ctx }) => ({
  items: await listProjects(ctx.db, { includeArchived: searchParams(req).get("includeArchived") === "true" }),
}));

export const POST = route(
  async ({ req, ctx }) => createProject(ctx.db, ctx.actor, await parseBody(req, createProjectBody)),
  { status: 201 },
);
