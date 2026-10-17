import { updateFieldBody } from "@/server/api/bodies";
import { parseBody, route } from "@/server/api/http";
import { updateSchemaField } from "@/server/services/schemas";

export const PATCH = route(async ({ req, ctx, params }) =>
  updateSchemaField(ctx.db, ctx.actor, params.id!, params.fieldId!, await parseBody(req, updateFieldBody)),
);
