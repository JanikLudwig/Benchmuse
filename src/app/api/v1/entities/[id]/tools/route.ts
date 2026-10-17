import { parseBody, route } from "@/server/api/http";
import { toolBody } from "@/server/api/sequenceBodies";
import {
  findPrimerSites,
  runAutoAnnotate,
  runDigest,
  runGuideSearch,
  runMotifSearch,
  runOrfSearch,
  runPcr,
  runPrimerDesign,
  runProperties,
  runTranslation,
} from "@/server/services/sequenceTools";

/**
 * Sequence analysis tools. One endpoint with a `tool` discriminator keeps the request shapes
 * in a single typed union rather than scattering a dozen near-identical routes.
 */
export const POST = route(async ({ req, ctx, params }) => {
  const body = await parseBody(req, toolBody);
  const id = params.id!;
  switch (body.tool) {
    case "digest":
      return runDigest(ctx.db, id, body);
    case "design-primers":
      return runPrimerDesign(ctx.db, id, body);
    case "pcr":
      return runPcr(ctx.db, id, body.forward, body.reverse);
    case "primer-sites":
      return findPrimerSites(ctx.db, id, body.primer);
    case "guides":
      return runGuideSearch(ctx.db, id, body);
    case "orfs":
      return runOrfSearch(ctx.db, id, body);
    case "translate":
      return runTranslation(ctx.db, id, body.range, body.strand ?? 1, body.geneticCode);
    case "properties":
      return runProperties(ctx.db, id, body.range);
    case "find":
      return runMotifSearch(ctx.db, id, body.pattern, body);
    case "auto-annotate":
      return runAutoAnnotate(ctx.db, id, body);
  }
});
