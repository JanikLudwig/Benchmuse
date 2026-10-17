import { addFieldBody } from "@/server/api/bodies";
import { parseBody, route } from "@/server/api/http";
import { addSchemaField } from "@/server/services/schemas";

export const POST = route(
  async ({ req, ctx, params }) => addSchemaField(ctx.db, ctx.actor, params.id!, await parseBody(req, addFieldBody)),
  { status: 201 },
);
