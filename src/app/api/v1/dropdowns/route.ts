import { createDropdownBody } from "@/server/api/bodies";
import { parseBody, route } from "@/server/api/http";
import { createDropdown, listDropdowns } from "@/server/services/schemas";

export const GET = route(async ({ ctx }) => ({ items: await listDropdowns(ctx.db) }));

export const POST = route(
  async ({ req, ctx }) => createDropdown(ctx.db, ctx.actor, await parseBody(req, createDropdownBody)),
  { status: 201 },
);
