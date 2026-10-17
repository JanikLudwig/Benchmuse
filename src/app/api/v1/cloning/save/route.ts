import { parseBody, route } from "@/server/api/http";
import { saveConstructBody } from "@/server/api/sequenceBodies";
import { createConstruct } from "@/server/services/cloning";

/** Create the entity a simulation produced, recording its parents. */
export const POST = route(
  async ({ req, ctx }) => createConstruct(ctx.db, ctx.actor, await parseBody(req, saveConstructBody)),
  { status: 201 },
);
