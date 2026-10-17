import { updateEntityBody } from "@/server/api/bodies";
import { parseBody, route } from "@/server/api/http";
import { getEntity, updateEntity } from "@/server/services/entities";

export const GET = route(async ({ ctx, params }) => getEntity(ctx.db, params.id!));

export const PATCH = route(async ({ req, ctx, params }) =>
  updateEntity(ctx.db, ctx.actor, params.id!, await parseBody(req, updateEntityBody)),
);
