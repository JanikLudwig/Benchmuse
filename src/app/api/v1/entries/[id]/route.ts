import { updateEntryBody } from "@/server/api/bodies";
import { parseBody, route } from "@/server/api/http";
import { getEntry, updateEntry } from "@/server/services/entries";

export const GET = route(async ({ ctx, params }) => getEntry(ctx.db, params.id!));

export const PATCH = route(async ({ req, ctx, params }) =>
  updateEntry(ctx.db, ctx.actor, params.id!, await parseBody(req, updateEntryBody)),
);
