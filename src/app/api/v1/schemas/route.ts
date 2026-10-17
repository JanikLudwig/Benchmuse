import { createSchemaBody } from "@/server/api/bodies";
import { parseBody, route, searchParams } from "@/server/api/http";
import { SCHEMA_KINDS, type SchemaKind } from "@/server/db/schema";
import { ValidationError } from "@/server/services/errors";
import { createSchema, listSchemas } from "@/server/services/schemas";

export const GET = route(async ({ req, ctx }) => {
  const kind = searchParams(req).get("kind");
  if (kind && !SCHEMA_KINDS.includes(kind as SchemaKind)) throw new ValidationError(`kind must be one of ${SCHEMA_KINDS.join(", ")}`);
  return { items: await listSchemas(ctx.db, { kind: (kind as SchemaKind) || undefined }) };
});

export const POST = route(
  async ({ req, ctx }) => createSchema(ctx.db, ctx.actor, await parseBody(req, createSchemaBody)),
  { status: 201 },
);
