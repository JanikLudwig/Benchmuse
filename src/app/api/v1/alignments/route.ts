import { parseBody, route, searchParams } from "@/server/api/http";
import { createAlignmentBody } from "@/server/api/sequenceBodies";
import { createAlignment, listAlignments } from "@/server/services/alignments";

export const GET = route(async ({ req, ctx }) => {
  const p = searchParams(req);
  return {
    items: await listAlignments(ctx.db, {
      referenceEntityId: p.get("referenceEntityId") ?? undefined,
      folderId: p.get("folderId") ?? undefined,
    }),
  };
});

export const POST = route(
  async ({ req, ctx }) => createAlignment(ctx.db, ctx.actor, await parseBody(req, createAlignmentBody)),
  { status: 201 },
);
