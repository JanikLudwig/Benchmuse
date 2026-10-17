/**
 * CRISPR guide RNA design.
 *
 * Finds protospacers next to a PAM, scores them for on-target quality using published sequence
 * rules, and searches supplied sequences for off-targets scored with the Hsu (2013) mismatch
 * weights — the same model as the original MIT specificity score.
 */

import { matchesPattern } from "./alphabet";
import { wrapIndex, type Range } from "./range";
import { findMatches, gcContent, reverseComplement } from "./seq";

export interface CasEnzyme {
  name: string;
  /** PAM in IUPAC codes, read 5'->3' on the protospacer strand */
  pam: string;
  /** which side of the protospacer the PAM sits on */
  pamSide: "3prime" | "5prime";
  spacerLength: number;
  /**
   * Blunt cut position, counted from the PAM-proximal end of the protospacer.
   * SpCas9 cuts between positions 17 and 18 of a 20 nt spacer, i.e. 3 bp from the PAM.
   */
  cutOffsetFromPam: number;
  /** staggered cutters leave an overhang instead of a blunt end */
  overhang?: number;
  description: string;
}

export const CAS_ENZYMES: readonly CasEnzyme[] = [
  { name: "SpCas9", pam: "NGG", pamSide: "3prime", spacerLength: 20, cutOffsetFromPam: 3, description: "Streptococcus pyogenes Cas9" },
  { name: "SpCas9-NG", pam: "NG", pamSide: "3prime", spacerLength: 20, cutOffsetFromPam: 3, description: "relaxed-PAM SpCas9 variant" },
  { name: "SaCas9", pam: "NNGRRT", pamSide: "3prime", spacerLength: 21, cutOffsetFromPam: 3, description: "Staphylococcus aureus Cas9" },
  { name: "Cas12a (Cpf1)", pam: "TTTV", pamSide: "5prime", spacerLength: 23, cutOffsetFromPam: 18, overhang: 5, description: "AsCpf1/LbCpf1, staggered cut" },
  { name: "Cas9-VQR", pam: "NGAN", pamSide: "3prime", spacerLength: 20, cutOffsetFromPam: 3, description: "SpCas9 VQR variant" },
];

export function getCasEnzyme(name: string): CasEnzyme | undefined {
  return CAS_ENZYMES.find((e) => e.name.toLowerCase() === name.toLowerCase());
}

export interface Guide {
  /** the 20 nt (or enzyme-specific) protospacer, 5'->3' on its own strand */
  spacer: string;
  pam: string;
  /** protospacer location on the top strand */
  range: Range;
  strand: 1 | -1;
  /** position on the top strand where the enzyme cuts */
  cutSite: number;
  gc: number;
  /** 0-100; sequence-rule estimate of cutting efficiency */
  onTargetScore: number;
  /** 0-100; 100 means no off-targets were found in the searched sequences */
  specificityScore: number;
  offTargets: OffTarget[];
  warnings: string[];
}

export interface OffTarget {
  /** which supplied sequence it was found in */
  source: string;
  range: Range;
  strand: 1 | -1;
  sequence: string;
  mismatches: number;
  /** positions (1-based, PAM-distal first) where the off-target differs */
  mismatchPositions: number[];
  /** Hsu score for this single site, 0-1 */
  score: number;
}

/**
 * Hsu (2013) position weights: how much a mismatch at each protospacer position reduces
 * cleavage. Index 0 is the PAM-distal end; mismatches near the PAM (high indices) matter most.
 */
const HSU_WEIGHTS = [
  0, 0, 0.014, 0, 0, 0.395, 0.317, 0, 0.389, 0.079,
  0.445, 0.508, 0.613, 0.851, 0.732, 0.828, 0.615, 0.804, 0.685, 0.583,
];

export interface FindGuidesOptions {
  enzyme?: CasEnzyme;
  /** restrict guides to those cutting inside this range */
  targetRange?: Range;
  /** sequences to search for off-targets; the target sequence itself is always searched */
  offTargetSources?: { name: string; sequence: string; isCircular: boolean }[];
  /** maximum mismatches to count as an off-target (default 4) */
  maxOffTargetMismatches?: number;
  /** cap the number of guides returned (default 50) */
  limit?: number;
}

/** Find and score guides in a sequence. */
export function findGuides(seq: string, isCircular: boolean, opts: FindGuidesOptions = {}): Guide[] {
  const enzyme = opts.enzyme ?? CAS_ENZYMES[0]!;
  const limit = opts.limit ?? 50;
  const upper = seq.toUpperCase();
  const L = upper.length;
  const guides: Guide[] = [];

  const at = (i: number): string | undefined => (isCircular ? upper[wrapIndex(i, L)] : i >= 0 && i < L ? upper[i] : undefined);
  const read = (start: number, length: number): string | null => {
    let out = "";
    for (let i = 0; i < length; i++) {
      const base = at(start + i);
      if (base === undefined) return null;
      out += base;
    }
    return out;
  };

  for (const strand of [1, -1] as const) {
    // Scan the strand the protospacer would be read from.
    const oriented = strand === 1 ? upper : reverseComplement(upper);
    const toTop = (i: number) => (strand === 1 ? i : L - i);

    for (let i = 0; i <= oriented.length - enzyme.pam.length; i++) {
      const pamSeq = oriented.slice(i, i + enzyme.pam.length);
      if (pamSeq.length < enzyme.pam.length) continue;
      if (![...pamSeq].every((b, k) => matchesPattern(b, enzyme.pam[k]!))) continue;

      let spacerStart: number;
      if (enzyme.pamSide === "3prime") spacerStart = i - enzyme.spacerLength;
      else spacerStart = i + enzyme.pam.length;
      if (!isCircular && (spacerStart < 0 || spacerStart + enzyme.spacerLength > oriented.length)) continue;

      const spacer = oriented.slice(spacerStart, spacerStart + enzyme.spacerLength);
      if (spacer.length !== enzyme.spacerLength || /[^ACGT]/.test(spacer)) continue;

      // Map back to top-strand coordinates.
      const topStart = strand === 1 ? spacerStart : toTop(spacerStart + enzyme.spacerLength);
      const topEnd = strand === 1 ? spacerStart + enzyme.spacerLength : toTop(spacerStart);
      const range: Range = { start: wrapIndex(topStart, L), end: wrapIndex(topEnd, L) || (topEnd === L ? L : 0) };

      const pamProximalIndex =
        enzyme.pamSide === "3prime" ? spacerStart + enzyme.spacerLength - enzyme.cutOffsetFromPam : spacerStart + enzyme.cutOffsetFromPam;
      const cutSite = wrapIndex(strand === 1 ? pamProximalIndex : toTop(pamProximalIndex), L);

      if (opts.targetRange) {
        const { start, end } = opts.targetRange;
        const inside = end > start ? cutSite >= start && cutSite < end : cutSite >= start || cutSite < end;
        if (!inside) continue;
      }

      guides.push({
        spacer,
        pam: pamSeq,
        range,
        strand,
        cutSite,
        gc: gcContent(spacer),
        onTargetScore: onTargetScore(spacer, pamSeq, enzyme),
        specificityScore: 100,
        offTargets: [],
        warnings: guideWarnings(spacer, enzyme),
      });
    }
  }

  // Score specificity against the target itself plus any extra sequences.
  const sources = [{ name: "target", sequence: upper, isCircular }, ...(opts.offTargetSources ?? [])];
  for (const guide of guides) {
    guide.offTargets = findOffTargets(guide, enzyme, sources, opts.maxOffTargetMismatches ?? 4);
    guide.specificityScore = specificityScore(guide.offTargets);
  }

  return guides
    .sort((a, b) => b.onTargetScore + b.specificityScore - (a.onTargetScore + a.specificityScore))
    .slice(0, limit);
}

/**
 * Sequence-rule estimate of on-target activity, 0-100.
 *
 * Built from the effects reported by Doench (2014/2016) and Wang (2014) that are robust across
 * datasets: moderate GC, no poly-T terminator, a purine at the PAM-proximal position, and no
 * extreme homopolymers. It ranks guides sensibly but is not a substitute for a trained model.
 */
export function onTargetScore(spacer: string, pam: string, enzyme: CasEnzyme = CAS_ENZYMES[0]!): number {
  let score = 70;
  const gc = gcContent(spacer);

  // GC content: 40-60% is best; both extremes reduce activity.
  if (gc >= 0.4 && gc <= 0.6) score += 12;
  else if (gc < 0.25 || gc > 0.8) score -= 28;
  else score -= 10;

  // A run of four or more Ts terminates Pol III transcription of the guide.
  if (/T{4,}/.test(spacer)) score -= 35;
  if (/([ACGT])\1{4,}/.test(spacer)) score -= 12;

  // The PAM-proximal position favours a purine; the position just 5' of the PAM favours G.
  const pamProximal = enzyme.pamSide === "3prime" ? spacer[spacer.length - 1]! : spacer[0]!;
  if (pamProximal === "G") score += 8;
  else if (pamProximal === "A") score += 3;
  else if (pamProximal === "C") score -= 5;

  // A C immediately 5' of a 3' PAM is slightly unfavourable; G is favourable.
  if (enzyme.pamSide === "3prime" && spacer.length >= 2) {
    const minusTwo = spacer[spacer.length - 2]!;
    if (minusTwo === "G") score += 4;
    if (minusTwo === "T") score -= 4;
  }

  // NGG PAMs with a G at the variable position cut slightly better.
  if (pam.length >= 1 && pam[0] === "G") score += 2;

  return Math.max(0, Math.min(100, Math.round(score)));
}

function guideWarnings(spacer: string, enzyme: CasEnzyme): string[] {
  const warnings: string[] = [];
  const gc = gcContent(spacer);
  if (/T{4,}/.test(spacer)) warnings.push("Contains TTTT, which terminates Pol III transcription");
  if (gc < 0.25) warnings.push(`GC content is only ${(gc * 100).toFixed(0)}%`);
  if (gc > 0.8) warnings.push(`GC content is ${(gc * 100).toFixed(0)}%`);
  if (/([ACGT])\1{4,}/.test(spacer)) warnings.push("Contains a homopolymer run of five or more");
  if (enzyme.pamSide === "3prime" && spacer[0] !== "G") {
    warnings.push("Does not start with G; U6 transcription prefers a 5' G (add one if cloning into a U6 vector)");
  }
  return warnings;
}

/** Hsu score for one off-target, 0-1. Higher means the off-target is more likely to be cut. */
export function hsuScore(mismatchPositions: readonly number[], spacerLength: number): number {
  const n = mismatchPositions.length;
  if (n === 0) return 1;

  // Term 1: position-specific penalties.
  let product = 1;
  for (const position of mismatchPositions) {
    // Map the position onto the 20-length Hsu matrix for enzymes with other spacer lengths.
    const index = Math.min(HSU_WEIGHTS.length - 1, Math.max(0, Math.round(((position - 1) / Math.max(1, spacerLength - 1)) * (HSU_WEIGHTS.length - 1))));
    product *= 1 - HSU_WEIGHTS[index]!;
  }

  // Term 2: mismatches spread far apart are tolerated better than clustered ones. With a single
  // mismatch there is no distance to measure, so the term is defined to be exactly 1.
  const span = spacerLength - 1;
  const sorted = [...mismatchPositions].sort((a, b) => a - b);
  const meanDistance = n > 1 ? (sorted[n - 1]! - sorted[0]!) / (n - 1) : span;
  const spread = Math.min(1, 1 / (((span - meanDistance) / span) * 4 + 1));

  // Term 3: more mismatches reduce cutting quadratically.
  return product * spread * (1 / (n * n));
}

/** MIT-style aggregate specificity: 100 means nothing else in the searched sequences is cut. */
export function specificityScore(offTargets: readonly OffTarget[]): number {
  const sum = offTargets.reduce((acc, o) => acc + o.score, 0);
  return Math.round((100 / (100 + 100 * sum)) * 100);
}

function findOffTargets(
  guide: Guide,
  enzyme: CasEnzyme,
  sources: { name: string; sequence: string; isCircular: boolean }[],
  maxMismatches: number,
): OffTarget[] {
  const results: OffTarget[] = [];
  for (const source of sources) {
    const upper = source.sequence.toUpperCase();
    const L = upper.length;
    for (const strand of [1, -1] as const) {
      const oriented = strand === 1 ? upper : reverseComplement(upper);
      for (let i = 0; i + enzyme.spacerLength + enzyme.pam.length <= oriented.length + (source.isCircular ? enzyme.spacerLength : 0); i++) {
        const spacerStart = enzyme.pamSide === "3prime" ? i : i + enzyme.pam.length;
        const pamStart = enzyme.pamSide === "3prime" ? i + enzyme.spacerLength : i;
        const candidate = sliceMaybeWrapped(oriented, spacerStart, enzyme.spacerLength, source.isCircular);
        const pamSeq = sliceMaybeWrapped(oriented, pamStart, enzyme.pam.length, source.isCircular);
        if (!candidate || !pamSeq) continue;
        if (![...pamSeq].every((b, k) => matchesPattern(b, enzyme.pam[k]!))) continue;

        const positions: number[] = [];
        for (let k = 0; k < guide.spacer.length; k++) {
          if (candidate[k] !== guide.spacer[k]) {
            positions.push(k + 1);
            if (positions.length > maxMismatches) break;
          }
        }
        if (positions.length > maxMismatches) continue;
        // The guide's own site is not an off-target.
        const topStart = strand === 1 ? spacerStart : L - spacerStart - enzyme.spacerLength;
        if (source.name === "target" && positions.length === 0 && wrapIndex(topStart, L) === guide.range.start) continue;

        results.push({
          source: source.name,
          range: { start: wrapIndex(topStart, L), end: wrapIndex(topStart + enzyme.spacerLength, L) },
          strand,
          sequence: candidate,
          mismatches: positions.length,
          mismatchPositions: positions,
          score: hsuScore(positions, enzyme.spacerLength),
        });
      }
    }
  }
  return results.sort((a, b) => b.score - a.score).slice(0, 100);
}

function sliceMaybeWrapped(seq: string, start: number, length: number, isCircular: boolean): string | null {
  if (start < 0) return null;
  if (start + length <= seq.length) return seq.slice(start, start + length);
  if (!isCircular) return null;
  const head = seq.slice(start);
  const tail = seq.slice(0, length - head.length);
  return head.length + tail.length === length ? head + tail : null;
}

// ---------------------------------------------------------------------------------------------
// Cloning helpers

/** Oligos for cloning a guide into a U6 vector cut with BbsI (the pX330/pSpCas9 scheme). */
export function guideCloningOligos(spacer: string, overhangs: { top: string; bottom: string } = { top: "CACCG", bottom: "AAAC" }): {
  top: string;
  bottom: string;
  note: string;
} {
  const body = spacer.toUpperCase();
  // U6 transcription starts with G; add one if the spacer does not already begin with G.
  const needsG = body[0] !== "G";
  const effective = needsG ? `G${body}` : body;
  return {
    top: `${overhangs.top}${needsG ? body : body.slice(1)}`,
    bottom: `${overhangs.bottom}${reverseComplement(needsG ? body : body.slice(1))}C`,
    note: needsG
      ? "A 5' G was added for U6 transcription, giving a 21 nt spacer."
      : "The spacer already begins with G, so no extra base was added.",
  };
}

/** Where a guide cuts, for showing repair templates and screening primers. */
export function cutSiteContext(seq: string, guide: Guide, flank = 20): { left: string; right: string } {
  const L = seq.length;
  const left = seq.slice(Math.max(0, guide.cutSite - flank), guide.cutSite);
  const right = seq.slice(guide.cutSite, Math.min(L, guide.cutSite + flank));
  return { left, right };
}

/** Enzymes whose recognition site is destroyed by cutting here, useful for screening edits. */
export function findMatchesNear(seq: string, pattern: string, position: number, window: number, isCircular: boolean) {
  return findMatches(seq, pattern, isCircular, { bothStrands: true }).filter(
    (m) => Math.abs(m.range.start - position) <= window,
  );
}
