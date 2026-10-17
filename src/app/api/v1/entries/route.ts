import { createEntryBody } from "@/server/api/bodies";
import { parseBody, route } from "@/server/api/http";
import { createEntry } from "@/server/services/entries";

export const POST = route(
  async ({ req, ctx }) => createEntry(ctx.db, ctx.actor, await parseBody(req, createEntryBody)),
  { status: 201 },
);
