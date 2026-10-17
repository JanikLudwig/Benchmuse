import { route } from "@/server/api/http";
import { getReadChromatogram } from "@/server/services/alignments";

/** Trace data for one read; null when the read did not come from a chromatogram. */
export const GET = route(async ({ ctx, params }) => ({ chromatogram: await getReadChromatogram(ctx.db, params.id!) }));
