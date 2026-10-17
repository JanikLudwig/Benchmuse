import { unarchiveBody } from "@/server/api/bodies";
import { parseBody, route } from "@/server/api/http";
import { setArchived } from "@/server/services/archive";

export const POST = route(async ({ req, ctx }) => {
  const { ids } = await parseBody(req, unarchiveBody);
  await setArchived(ctx.db, ctx.actor, ids, null);
  return { unarchived: ids };
});
