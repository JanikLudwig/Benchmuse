/** The in-memory form every importer produces and every exporter consumes. */

import type { Range } from "../range";

export interface BioFeature {
  /** display name, resolved from /label, /gene, /product or /note */
  name: string;
  /** GenBank feature key: CDS, promoter, primer_bind, misc_feature… */
  type: string;
  strand: 1 | -1 | 0;
  /** one entry for a simple feature; several for a join (exons, origin-spanning features) */
  segments: Range[];
  qualifiers: Record<string, string[]>;
  color?: string;
  partial5?: boolean;
  partial3?: boolean;
}

export interface SequenceRecord {
  name: string;
  description?: string;
  accession?: string;
  version?: string;
  organism?: string;
  kind: "dna" | "aa";
  isCircular: boolean;
  residues: string;
  features: BioFeature[];
  comments?: string[];
  format: "genbank" | "fasta" | "snapgene" | "ab1";
  /** per-base quality scores, when the source had them (AB1) */
  qualities?: number[];
}

export interface ParseWarning {
  message: string;
  line?: number;
}

export interface ParseResult {
  records: SequenceRecord[];
  warnings: ParseWarning[];
}

/** Overall span of a feature: first segment start to last segment end. */
export function featureSpan(feature: Pick<BioFeature, "segments">): Range {
  const first = feature.segments[0];
  const last = feature.segments[feature.segments.length - 1];
  if (!first || !last) return { start: 0, end: 0 };
  return { start: first.start, end: last.end };
}

/**
 * A GenBank join whose segments are listed as `[…end-of-sequence, start-of-sequence…]` is a
 * feature crossing the origin. Collapse that into one wrapping range so the viewer draws it as
 * a single arc.
 */
export function collapseOriginSpan(segments: Range[], seqLength: number): Range | null {
  if (segments.length !== 2) return null;
  const [a, b] = segments as [Range, Range];
  if (a.end === seqLength && b.start === 0) return { start: a.start, end: b.end };
  return null;
}
