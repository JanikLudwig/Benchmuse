import { parseBody, route } from "@/server/api/http";
import { cloningBody } from "@/server/api/sequenceBodies";
import { simulateGibson, simulateGoldenGate, simulatePcrProduct, simulateRestrictionClone } from "@/server/services/cloning";

/** Simulate a construction. Nothing is written until the product is saved. */
export const POST = route(async ({ req, ctx }) => {
  const body = await parseBody(req, cloningBody);
  switch (body.method) {
    case "restriction_ligation":
      return simulateRestrictionClone(ctx.db, body);
    case "golden_gate":
      return simulateGoldenGate(ctx.db, body);
    case "gibson":
      return simulateGibson(ctx.db, body);
    case "pcr":
      return simulatePcrProduct(ctx.db, body);
  }
});
