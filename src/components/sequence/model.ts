/** Shared view model for the sequence workspace: features, selection and overlays. */

export interface Segment {
  start: number;
  end: number;
}

export interface SequenceFeature {
  id: string;
  name: string;
  type: string;
  strand: 1 | -1 | 0;
  segments: Segment[];
  qualifiers?: Record<string, string[]>;
  color?: string;
}

/** A highlighted region drawn over the sequence: a cut site, a primer, a guide, a search hit. */
export interface Overlay {
  id: string;
  kind: "cut" | "primer" | "guide" | "match" | "variant" | "read";
  label: string;
  /** half-open range on the top strand; end <= start wraps the origin */
  range: Segment;
  strand?: 1 | -1 | 0;
  color: string;
  detail?: string;
}

export interface Selection {
  start: number;
  end: number;
  /** which strand the user is working on; affects translation and primer direction */
  strand: 1 | -1;
}

export const FEATURE_COLORS: Record<string, string> = {
  CDS: "#6366f1",
  gene: "#8b5cf6",
  promoter: "#10b981",
  terminator: "#ef4444",
  RBS: "#f59e0b",
  rep_origin: "#f59e0b",
  primer_bind: "#0ea5e9",
  protein_bind: "#a855f7",
  misc_feature: "#64748b",
  source: "#94a3b8",
  regulatory: "#14b8a6",
  mat_peptide: "#ec4899",
  sig_peptide: "#ec4899",
  exon: "#6366f1",
  intron: "#cbd5e1",
};

export const OVERLAY_COLORS: Record<Overlay["kind"], string> = {
  cut: "#dc2626",
  primer: "#0ea5e9",
  guide: "#a855f7",
  match: "#f59e0b",
  variant: "#dc2626",
  read: "#10b981",
};

export function featureColor(feature: Pick<SequenceFeature, "type" | "color">): string {
  return feature.color ?? FEATURE_COLORS[feature.type] ?? FEATURE_COLORS.misc_feature!;
}

/** Does this range wrap the origin? */
export const wraps = (range: Segment): boolean => range.end <= range.start;

/** Linear pieces a range covers. */
export function pieces(range: Segment, length: number): Segment[] {
  if (!wraps(range)) return [{ start: range.start, end: Math.min(range.end, length) }];
  const out: Segment[] = [];
  if (range.start < length) out.push({ start: range.start, end: length });
  if (range.end > 0) out.push({ start: 0, end: range.end });
  return out;
}

export function rangeLength(range: Segment, length: number): number {
  return wraps(range) ? length - range.start + range.end : range.end - range.start;
}

/** Total bases a feature covers across all its segments. */
export function featureLength(feature: SequenceFeature, length: number): number {
  return feature.segments.reduce((n, s) => n + rangeLength(s, length), 0);
}

/** Overall span of a feature, from its first segment's start to its last segment's end. */
export function featureSpan(feature: SequenceFeature): Segment {
  const first = feature.segments[0];
  const last = feature.segments[feature.segments.length - 1];
  return { start: first?.start ?? 0, end: last?.end ?? 0 };
}

export function contains(range: Segment, index: number, length: number): boolean {
  return pieces(range, length).some((p) => index >= p.start && index < p.end);
}

export function overlaps(a: Segment, b: Segment, length: number): boolean {
  const as = pieces(a, length);
  const bs = pieces(b, length);
  return as.some((x) => bs.some((y) => x.start < y.end && y.start < x.end));
}

/** 1-based inclusive label, as biologists read coordinates. */
export function displayRange(range: Segment, length: number): string {
  const span = rangeLength(range, length);
  if (span === 0) return `${range.start + 1}`;
  const last = wraps(range) ? range.end : range.end;
  return `${range.start + 1}–${last}`;
}

export function formatLength(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 1 : 2).replace(/\.?0+$/, "")} kb` : `${n} bp`;
}

/**
 * Greedy interval packing: overlapping features are placed on successive tracks so none hide
 * another.
 */
export function assignTracks(features: readonly SequenceFeature[], length: number): Map<string, number> {
  const sorted = [...features].sort((a, b) => featureLength(b, length) - featureLength(a, length));
  const occupied: Segment[][] = [];
  const tracks = new Map<string, number>();
  for (const feature of sorted) {
    const ranges = feature.segments.flatMap((s) => pieces(s, length));
    let track = 0;
    while (occupied[track]?.some((o) => ranges.some((r) => r.start < o.end && o.start < r.end))) track++;
    (occupied[track] ??= []).push(...ranges);
    tracks.set(feature.id, track);
  }
  return tracks;
}

/** Normalize a drag into a forward range. */
export function normalizeSelection(anchor: number, focus: number, strand: 1 | -1): Selection {
  return { start: Math.min(anchor, focus), end: Math.max(anchor, focus), strand };
}

export const GENBANK_FEATURE_TYPES = [
  "CDS",
  "gene",
  "promoter",
  "terminator",
  "RBS",
  "rep_origin",
  "primer_bind",
  "protein_bind",
  "regulatory",
  "misc_feature",
  "mat_peptide",
  "sig_peptide",
  "exon",
  "intron",
  "source",
  "repeat_region",
  "polyA_signal",
  "LTR",
  "mobile_element",
  "oriT",
  "stem_loop",
  "variation",
] as const;
