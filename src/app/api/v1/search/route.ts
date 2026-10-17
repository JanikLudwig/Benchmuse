import { intParam, route, searchParams } from "@/server/api/http";
import { search } from "@/server/services/search";

/** GET /api/v1/search?q=&filter=&sort=&limit=&offset= (filter grammar: src/server/domain/filters.ts) */
export const GET = route(async ({ req, ctx }) => {
  const p = searchParams(req);
  return search(ctx.db, {
    q: p.get("q"),
    filter: p.get("filter"),
    sort: p.get("sort"),
    limit: intParam(p.get("limit")),
    offset: intParam(p.get("offset")),
  });
});
