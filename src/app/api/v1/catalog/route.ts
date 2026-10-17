import { route, searchParams } from "@/server/api/http";
import { CAS_ENZYMES } from "@/bio/crispr";
import { COMMON_ENZYMES, ENZYMES } from "@/bio/enzymes";
import { PARTS } from "@/bio/features/library";
import { LADDERS } from "@/bio/gel";
import { GENETIC_CODES } from "@/bio/seq";

/**
 * Reference data the UI needs: enzymes, Cas variants, parts, ladders and genetic codes.
 * Static for a given build, so it is cached.
 */
export const GET = route(async ({ req }) => {
  const all = searchParams(req).get("all") === "true";
  const enzymes = all ? ENZYMES : COMMON_ENZYMES;
  return {
    enzymes: enzymes.map((e) => ({
      name: e.name,
      site: e.site,
      overhangType: e.overhangType,
      overhangLength: e.overhangLength,
      isTypeIIS: e.isTypeIIS,
      common: e.common,
    })),
    totalEnzymes: ENZYMES.length,
    casEnzymes: CAS_ENZYMES,
    parts: PARTS.map((p) => ({ name: p.name, type: p.type, category: p.category, length: p.sequence.length, description: p.description })),
    ladders: LADDERS,
    geneticCodes: Object.values(GENETIC_CODES).map((c) => ({ id: c.id, name: c.name })),
  };
});
