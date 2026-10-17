import { addOptionBody } from "@/server/api/bodies";
import { parseBody, route } from "@/server/api/http";
import { addDropdownOption } from "@/server/services/schemas";

export const POST = route(
  async ({ req, ctx, params }) => addDropdownOption(ctx.db, ctx.actor, params.id!, (await parseBody(req, addOptionBody)).name),
  { status: 201 },
);
