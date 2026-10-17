import { importPasteBody } from "@/server/api/sequenceBodies";
import { parseBody, route } from "@/server/api/http";
import { importPastedSequence } from "@/server/services/importing";

export const POST = route(
  async ({ req, ctx }) => ({ items: await importPastedSequence(ctx.db, ctx.actor, await parseBody(req, importPasteBody)) }),
  { status: 201 },
);
