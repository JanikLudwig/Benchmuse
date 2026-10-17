import { createEntityBody } from "@/server/api/bodies";
import { parseBody, route, searchParams } from "@/server/api/http";
import { ValidationError } from "@/server/services/errors";
import { createEntity, getEntitiesByIds } from "@/server/services/entities";

/** GET /api/v1/entities?ids=ent_a,ent_b (batch lookup; use /search for querying). */
export const GET = route(async ({ req, ctx }) => {
  const ids = (searchParams(req).get("ids") ?? "").split(",").filter(Boolean);
  if (!ids.length || ids.length > 500) throw new ValidationError("Pass 1-500 comma-separated ids");
  return { items: await getEntitiesByIds(ctx.db, ids) };
});

export const POST = route(
  async ({ req, ctx }) => createEntity(ctx.db, ctx.actor, await parseBody(req, createEntityBody)),
  { status: 201 },
);
