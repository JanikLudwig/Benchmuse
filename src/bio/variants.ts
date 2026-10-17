/**
 * Turn an alignment into a list of differences, and work out what each one does to the
 * proteins encoded nearby.
 *
 * Indels are left-aligned, the convention HGVS and every variant database use, so the same
 * change in a homopolymer is always reported at the same position.
 */

import type { Alignment } from "./align";
import type { BioFeature } from "./formats/types";
import { rangeLength, segments as rangeSegments, type Range } from "./range";
import { GENETIC_CODES, reverseComplement, translate, type GeneticCode } from "./seq";

export type VariantType = "substitution" | "insertion" | "deletion";

export type Consequence =
  | "synonymous"
  | "missense"
  | "nonsense"
  | "stop lost"
  | "start lost"
  | "frameshift"
  | "in-frame insertion"
  | "in-frame deletion"
  | "non-coding";

export interface VariantEffect {
  featureName: string;
  consequence: Consequence;
  /** 1-based codon number within the coding sequence */
  aaPosition?: number;
  codonChange?: string;
  /** HGVS-style protein change, e.g. p.Glu5Gly */
  proteinChange?: string;
}

export interface Variant {
  type: VariantType;
  /** half-open reference span the variant replaces (empty for insertions) */
  refStart: number;
  refEnd: number;
  refBases: string;
  queryBases: string;
  /** index in the oriented query where the variant's bases begin */
  queryPosition: number;
  /** lowest base-call quality among the query bases involved, when qualities are available */
  quality?: number;
  /** HGVS-style label on the reference, e.g. g.123A>G */
  label: string;
  effects: VariantEffect[];
}

const AA3: Readonly<Record<string, string>> = {
  A: "Ala", R: "Arg", N: "Asn", D: "Asp", C: "Cys", Q: "Gln", E: "Glu", G: "Gly", H: "His", I: "Ile",
  L: "Leu", K: "Lys", M: "Met", F: "Phe", P: "Pro", S: "Ser", T: "Thr", W: "Trp", Y: "Tyr", V: "Val",
  "*": "Ter", X: "Xaa",
};

const three = (aa: string): string => AA3[aa.toUpperCase()] ?? "Xaa";

export interface CallVariantsOptions {
  /** features to predict effects against; CDS features are used for coding consequences */
  features?: readonly BioFeature[];
  /** per-base qualities of the oriented query, same length as the query */
  qualities?: readonly number[];
  /** ignore differences where the query base quality is below this (default 0 = report all) */
  minQuality?: number;
  geneticCode?: GeneticCode;
  /** reference length, needed to resolve circular coordinates */
  referenceLength?: number;
  isCircular?: boolean;
}

/**
 * Walk an alignment and emit one variant per difference.
 *
 * `reference` and the alignment must correspond: `alignment.alignedRef` is the gapped reference
 * starting at `alignment.refStart`.
 */
export function callVariants(
  reference: string,
  alignment: Alignment,
  opts: CallVariantsOptions = {},
): Variant[] {
  const refLength = opts.referenceLength ?? reference.length;
  const isCircular = opts.isCircular ?? false;
  const minQuality = opts.minQuality ?? 0;
  const raw: Variant[] = [];

  let refPos = alignment.refStart;
  let queryPos = alignment.queryStart;
  const ar = alignment.alignedRef;
  const aq = alignment.alignedQuery;

  let i = 0;
  while (i < ar.length) {
    const r = ar[i]!;
    const q = aq[i]!;

    if (r === "-") {
      // Insertion in the query relative to the reference.
      let len = 0;
      while (i + len < ar.length && ar[i + len] === "-") len++;
      raw.push(makeVariant("insertion", refPos, refPos, "", aq.slice(i, i + len), queryPos, opts));
      queryPos += len;
      i += len;
      continue;
    }
    if (q === "-") {
      let len = 0;
      while (i + len < aq.length && aq[i + len] === "-") len++;
      raw.push(makeVariant("deletion", refPos, refPos + len, ar.slice(i, i + len), "", queryPos, opts));
      refPos += len;
      i += len;
      continue;
    }
    if (r.toUpperCase() !== q.toUpperCase()) {
      raw.push(makeVariant("substitution", refPos, refPos + 1, r, q, queryPos, opts));
    }
    refPos++;
    queryPos++;
    i++;
  }

  const normalized = raw
    .map((v) => (v.type === "substitution" ? v : leftAlign(v, reference, refLength, isCircular)))
    .filter((v) => v.quality === undefined || v.quality >= minQuality);

  for (const variant of normalized) {
    variant.label = hgvsLabel(variant, refLength, isCircular);
    variant.effects = predictEffects(variant, reference, opts);
  }
  return normalized;
}

function makeVariant(
  type: VariantType,
  refStart: number,
  refEnd: number,
  refBases: string,
  queryBases: string,
  queryPosition: number,
  opts: CallVariantsOptions,
): Variant {
  const qualities = opts.qualities;
  let quality: number | undefined;
  if (qualities && queryBases.length) {
    quality = Math.min(...[...queryBases].map((_, k) => qualities[queryPosition + k] ?? 0));
  } else if (qualities && type === "deletion") {
    // Use the flanking base quality: a deletion has no query bases of its own.
    quality = Math.min(qualities[queryPosition - 1] ?? 0, qualities[queryPosition] ?? 0);
  }
  return { type, refStart, refEnd, refBases, queryBases, queryPosition, quality, label: "", effects: [] };
}

/** Shift an indel as far 5' as possible without changing the resulting sequence. */
function leftAlign(variant: Variant, reference: string, refLength: number, isCircular: boolean): Variant {
  const baseAt = (i: number): string | undefined => {
    if (isCircular) return reference[((i % refLength) + refLength) % refLength];
    return i >= 0 && i < refLength ? reference[i] : undefined;
  };
  const v = { ...variant };
  let guard = 0;
  while (guard++ < 1000) {
    const before = baseAt(v.refStart - 1);
    if (before === undefined) break;
    if (v.type === "deletion") {
      const last = v.refBases[v.refBases.length - 1];
      if (!last || before.toUpperCase() !== last.toUpperCase()) break;
      v.refBases = before + v.refBases.slice(0, -1);
      v.refStart--;
      v.refEnd--;
    } else {
      const last = v.queryBases[v.queryBases.length - 1];
      if (!last || before.toUpperCase() !== last.toUpperCase()) break;
      v.queryBases = before + v.queryBases.slice(0, -1);
      v.refStart--;
      v.refEnd--;
      v.queryPosition--;
    }
  }
  return v;
}

function hgvsLabel(v: Variant, refLength: number, isCircular: boolean): string {
  const pos = (i: number) => (isCircular ? (((i % refLength) + refLength) % refLength) + 1 : i + 1);
  switch (v.type) {
    case "substitution":
      return `g.${pos(v.refStart)}${v.refBases.toUpperCase()}>${v.queryBases.toUpperCase()}`;
    case "deletion":
      return v.refBases.length === 1
        ? `g.${pos(v.refStart)}del`
        : `g.${pos(v.refStart)}_${pos(v.refEnd - 1)}del`;
    case "insertion":
      return `g.${pos(v.refStart - 1)}_${pos(v.refStart)}ins${v.queryBases.toUpperCase()}`;
  }
}

// ---------------------------------------------------------------------------------------------
// Coding consequences

function predictEffects(variant: Variant, reference: string, opts: CallVariantsOptions): VariantEffect[] {
  const features = opts.features ?? [];
  const code = opts.geneticCode ?? GENETIC_CODES[1]!;
  const refLength = opts.referenceLength ?? reference.length;
  const isCircular = opts.isCircular ?? false;
  const effects: VariantEffect[] = [];

  for (const feature of features) {
    if (feature.type !== "CDS") continue;
    const cdsPos = toCdsPosition(variant.refStart, feature, refLength, isCircular);
    if (cdsPos === null) continue;

    const cds = featureBases(reference, feature, refLength, isCircular);
    if (cds.length < 3) continue;

    if (variant.type === "substitution") {
      effects.push(substitutionEffect(variant, feature, cds, cdsPos, code));
      continue;
    }
    const delta = variant.queryBases.length - variant.refBases.length;
    if (delta % 3 !== 0) {
      effects.push({
        featureName: feature.name,
        consequence: "frameshift",
        aaPosition: Math.floor(cdsPos / 3) + 1,
        proteinChange: `p.${three(translate(cds, { code })[Math.floor(cdsPos / 3)] ?? "X")}${Math.floor(cdsPos / 3) + 1}fs`,
      });
    } else {
      effects.push({
        featureName: feature.name,
        consequence: variant.type === "insertion" ? "in-frame insertion" : "in-frame deletion",
        aaPosition: Math.floor(cdsPos / 3) + 1,
      });
    }
  }

  if (!effects.length) effects.push({ featureName: "", consequence: "non-coding" });
  return effects;
}

function substitutionEffect(
  variant: Variant,
  feature: BioFeature,
  cds: string,
  cdsPos: number,
  code: GeneticCode,
): VariantEffect {
  const codonIndex = Math.floor(cdsPos / 3);
  const offsetInCodon = cdsPos % 3;
  const refCodon = cds.slice(codonIndex * 3, codonIndex * 3 + 3);
  if (refCodon.length < 3) return { featureName: feature.name, consequence: "non-coding" };

  // On the minus strand the substituted base is complemented before it enters the codon.
  const queryBase = feature.strand === -1 ? reverseComplement(variant.queryBases) : variant.queryBases;
  const altCodon = refCodon.slice(0, offsetInCodon) + queryBase.toUpperCase() + refCodon.slice(offsetInCodon + 1);

  const refAa = translate(refCodon, { code });
  const altAa = translate(altCodon, { code });
  const aaPosition = codonIndex + 1;

  let consequence: Consequence;
  if (refAa === altAa) consequence = "synonymous";
  else if (altAa === "*") consequence = "nonsense";
  else if (refAa === "*") consequence = "stop lost";
  else if (aaPosition === 1) consequence = "start lost";
  else consequence = "missense";

  return {
    featureName: feature.name,
    consequence,
    aaPosition,
    codonChange: `${refCodon.toUpperCase()}>${altCodon.toUpperCase()}`,
    proteinChange:
      consequence === "synonymous"
        ? `p.${three(refAa)}${aaPosition}=`
        : `p.${three(refAa)}${aaPosition}${three(altAa)}`,
  };
}

/** Position of a reference index within a feature's coding sequence, or null if outside. */
function toCdsPosition(refIndex: number, feature: BioFeature, refLength: number, isCircular: boolean): number | null {
  const pieces = feature.segments.flatMap((s) => rangeSegments(s, refLength, isCircular));
  let consumed = 0;
  const ordered = feature.strand === -1 ? [...pieces].reverse() : pieces;
  for (const piece of ordered) {
    const length = piece.end - piece.start;
    if (refIndex >= piece.start && refIndex < piece.end) {
      return feature.strand === -1 ? consumed + (piece.end - 1 - refIndex) : consumed + (refIndex - piece.start);
    }
    consumed += length;
  }
  return null;
}

/** The feature's bases in its own 5'->3' direction. */
function featureBases(reference: string, feature: BioFeature, refLength: number, isCircular: boolean): string {
  const bases = feature.segments
    .flatMap((s) => rangeSegments(s, refLength, isCircular))
    .map((s) => reference.slice(s.start, s.end))
    .join("");
  return feature.strand === -1 ? reverseComplement(bases) : bases;
}

/** Total length of a feature, for display. */
export function featureLength(feature: BioFeature, refLength: number, isCircular: boolean): number {
  return feature.segments.reduce((n, s) => n + rangeLength(s, refLength, isCircular), 0);
}

/** Group variants by the consequence a reviewer cares about most. */
export function summarizeVariants(variants: readonly Variant[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const v of variants) {
    const worst = v.effects.reduce<Consequence>((acc, e) => (severity(e.consequence) > severity(acc) ? e.consequence : acc), "non-coding");
    counts[worst] = (counts[worst] ?? 0) + 1;
  }
  return counts;
}

const SEVERITY: Consequence[] = [
  "non-coding",
  "synonymous",
  "in-frame insertion",
  "in-frame deletion",
  "missense",
  "start lost",
  "stop lost",
  "frameshift",
  "nonsense",
];

function severity(c: Consequence): number {
  return SEVERITY.indexOf(c);
}
