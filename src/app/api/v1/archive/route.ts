import { archiveBody } from "@/server/api/bodies";
import { parseBody, route } from "@/server/api/http";
import { setArchived } from "@/server/services/archive";

export const POST = route(async ({ req, ctx }) => {
  const { ids, reason } = await parseBody(req, archiveBody);
  await setArchived(ctx.db, ctx.actor, ids, reason);
  return { archived: ids };
});
