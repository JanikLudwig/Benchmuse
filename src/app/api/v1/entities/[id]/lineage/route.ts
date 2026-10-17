import { intParam, route, searchParams } from "@/server/api/http";
import { getLineageGraph } from "@/server/services/lineage";

export const GET = route(async ({ req, ctx, params }) =>
  getLineageGraph(ctx.db, params.id!, Math.min(intParam(searchParams(req).get("depth")) ?? 3, 6)),
);
