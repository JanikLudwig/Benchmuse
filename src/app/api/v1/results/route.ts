import { createResultsBody } from "@/server/api/bodies";
import { parseBody, route, searchParams } from "@/server/api/http";
import { ValidationError } from "@/server/services/errors";
import { createResults, listResults } from "@/server/services/entries";

export const GET = route(async ({ req, ctx }) => {
  const p = searchParams(req);
  const schemaId = p.get("schemaId") ?? undefined;
  const entryId = p.get("entryId") ?? undefined;
  if (!schemaId && !entryId) throw new ValidationError("Pass schemaId and/or entryId");
  return { items: await listResults(ctx.db, { schemaId, entryId }) };
});

export const POST = route(
  async ({ req, ctx }) => ({ items: await createResults(ctx.db, ctx.actor, await parseBody(req, createResultsBody)) }),
  { status: 201 },
);
