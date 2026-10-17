import { updateSchemaBody } from "@/server/api/bodies";
import { parseBody, route } from "@/server/api/http";
import { getSchema, updateSchema } from "@/server/services/schemas";

export const GET = route(async ({ ctx, params }) => getSchema(ctx.db, params.id!));

export const PATCH = route(async ({ req, ctx, params }) =>
  updateSchema(ctx.db, ctx.actor, params.id!, await parseBody(req, updateSchemaBody)),
);
