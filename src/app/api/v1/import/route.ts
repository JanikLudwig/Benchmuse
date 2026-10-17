import { importCommitBody } from "@/server/api/sequenceBodies";
import { parseBody, route } from "@/server/api/http";
import { commitImport } from "@/server/services/importing";

export const POST = route(
  async ({ req, ctx }) => {
    const body = await parseBody(req, importCommitBody);
    const names = body.names
      ? Object.fromEntries(Object.entries(body.names).map(([k, v]) => [Number(k), v]))
      : undefined;
    return { items: await commitImport(ctx.db, ctx.actor, { ...body, names }) };
  },
  { status: 201 },
);
