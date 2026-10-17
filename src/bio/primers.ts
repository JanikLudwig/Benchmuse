/**
 * Primer binding, PCR simulation and primer design.
 *
 * Primers are matched by their 3' anchor, because that is what determines whether a polymerase
 * can extend. Unmatched 5' bases become a "tail", which is how restriction sites, Gibson
 * overlaps and Golden Gate adapters are carried into the product.
 */

import { couldMatch } from "./alphabet";
import { withDefaults } from "./options";
import { wrapIndex, type Range } from "./range";
import { findMatches, gcContent, reverseComplement } from "./seq";
import {
  DEFAULT_CONDITIONS,
  hairpin,
  longestHomopolymer,
  meltingTemp,
  pairedDg,
  selfDimer,
  type Conditions,
  type StructureHit,
} from "./thermo";

export interface BindingSite {
  /** region of the top strand the primer anneals to */
  range: Range;
  /** 1 = extends rightwards along the top strand, -1 = leftwards */
  strand: 1 | -1;
  /** number of 3'-anchored primer bases that annealed */
  annealedLength: number;
  mismatches: number;
  /** 5' primer bases that do not anneal (restriction site, overlap, barcode…) */
  tail: string;
  /** Tm of the annealed portion only */
  tm: number;
  /** top-strand index the polymerase extends from */
  extendFrom: number;
}

export interface BindingOptions {
  /** shortest 3' anchor that counts as binding (default 12) */
  minAnchor?: number;
  /** mismatches allowed outside the 3' anchor (default 2) */
  maxMismatches?: number;
  /** 3'-terminal bases that must match exactly (default 3) */
  exact3Prime?: number;
  conditions?: Conditions;
}

/**
 * Find everywhere a primer can prime on a template.
 *
 * Anchors are located by exact search on the 3' end, then extended 5'-wards allowing a few
 * mismatches, which is both fast and a good model of real priming.
 *
 * A consequence worth knowing: a primer mismatched within `minAnchor` bases of its 3' end is
 * reported as not binding. That matches the bench behaviour of such primers, and it is why
 * mutagenesis primers carry their mismatch in the middle rather than near the 3' end.
 */
export function findBindingSites(template: string, primer: string, isCircular: boolean, opts: BindingOptions = {}): BindingSite[] {
  const minAnchor = opts.minAnchor ?? 12;
  const maxMismatches = opts.maxMismatches ?? 2;
  const exact3 = opts.exact3Prime ?? 3;
  const seq = template.toUpperCase();
  const p = primer.replace(/\s/g, "").toUpperCase();
  const L = seq.length;
  if (p.length < minAnchor || !L) return [];

  const sites: BindingSite[] = [];
  const at = (i: number): string | undefined => {
    if (isCircular) return seq[wrapIndex(i, L)];
    return i >= 0 && i < L ? seq[i] : undefined;
  };

  // Forward: the primer sequence itself appears on the top strand, 3' end last.
  const fwdAnchor = p.slice(p.length - minAnchor);
  for (const hit of findMatches(seq, fwdAnchor, isCircular)) {
    const anchorEnd = hit.range.start + minAnchor; // exclusive, may exceed L on a circle
    // Extend 5'-wards, tolerating internal mismatches but never ending on one: a 5' base that
    // does not pair is part of the tail, not of the annealed duplex.
    let annealed = minAnchor;
    let mismatches = 0;
    let running = 0;
    for (let j = minAnchor; j < p.length; j++) {
      const base = at(anchorEnd - 1 - j);
      if (base === undefined) break;
      if (!couldMatch(base, p[p.length - 1 - j]!)) {
        if (running + 1 > maxMismatches) break;
        running++;
        continue;
      }
      annealed = j + 1;
      mismatches = running;
    }
    if (!terminalMatches(p, anchorEnd - 1, exact3, at, 1)) continue;
    const start = anchorEnd - annealed;
    sites.push({
      range: { start: wrapIndex(start, L), end: isCircular ? wrapIndex(anchorEnd, L) : anchorEnd },
      strand: 1,
      annealedLength: annealed,
      mismatches,
      tail: primer.slice(0, primer.length - annealed),
      tm: meltingTemp(p.slice(p.length - annealed), opts.conditions),
      extendFrom: isCircular ? wrapIndex(anchorEnd, L) : anchorEnd,
    });
  }

  // Reverse: the reverse complement of the primer appears on the top strand, 3' end first.
  const rc = reverseComplement(p);
  const revAnchor = rc.slice(0, minAnchor);
  for (const hit of findMatches(seq, revAnchor, isCircular)) {
    const anchorStart = hit.range.start;
    let annealed = minAnchor;
    let mismatches = 0;
    let running = 0;
    for (let j = minAnchor; j < rc.length; j++) {
      const base = at(anchorStart + j);
      if (base === undefined) break;
      if (!couldMatch(base, rc[j]!)) {
        if (running + 1 > maxMismatches) break;
        running++;
        continue;
      }
      annealed = j + 1;
      mismatches = running;
    }
    if (!terminalMatches(rc, anchorStart, exact3, at, -1)) continue;
    const end = anchorStart + annealed;
    sites.push({
      range: { start: wrapIndex(anchorStart, L), end: isCircular ? wrapIndex(end, L) : Math.min(end, L) },
      strand: -1,
      annealedLength: annealed,
      mismatches,
      tail: primer.slice(0, primer.length - annealed),
      tm: meltingTemp(p.slice(p.length - annealed), opts.conditions),
      extendFrom: isCircular ? wrapIndex(anchorStart - 1, L) : anchorStart - 1,
    });
  }

  return sites.sort((a, b) => a.range.start - b.range.start || a.strand - b.strand);
}

/** The last `n` bases at the primer's 3' end must match exactly for extension to occur. */
function terminalMatches(
  oriented: string,
  anchorIndex: number,
  n: number,
  at: (i: number) => string | undefined,
  direction: 1 | -1,
): boolean {
  for (let j = 0; j < n; j++) {
    const primerBase = direction === 1 ? oriented[oriented.length - 1 - j] : oriented[j];
    const templateBase = at(anchorIndex + (direction === 1 ? -j : j));
    if (!primerBase || templateBase === undefined || !couldMatch(templateBase, primerBase)) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------------------------
// PCR

export interface Amplicon {
  sequence: string;
  length: number;
  /** region of the template the product covers (annealing site to annealing site) */
  templateRange: Range;
  forwardSite: BindingSite;
  reverseSite: BindingSite;
  /** recommended annealing temperature, °C */
  annealingTemp: number;
  /** Tm of the full product, for long-amplicon protocols */
  productTm: number;
}

export interface PcrOptions extends BindingOptions {
  /** longest product to report (default 20 kb) */
  maxProductLength?: number;
}

export interface PcrResult {
  products: Amplicon[];
  forwardSites: BindingSite[];
  reverseSites: BindingSite[];
  warnings: string[];
}

/**
 * Simulate a PCR. Every forward site is paired with every downstream reverse site, so
 * mispriming shows up as extra products rather than being silently ignored.
 */
export function simulatePcr(
  template: string,
  forward: string,
  reverse: string,
  isCircular: boolean,
  opts: PcrOptions = {},
): PcrResult {
  const maxLength = opts.maxProductLength ?? 20000;
  const L = template.length;
  const forwardAll = findBindingSites(template, forward, isCircular, opts);
  const reverseAll = findBindingSites(template, reverse, isCircular, opts);
  const forwardSites = forwardAll.filter((s) => s.strand === 1);
  const reverseSites = reverseAll.filter((s) => s.strand === -1);
  const warnings: string[] = [];
  const products: Amplicon[] = [];

  for (const f of forwardSites) {
    for (const r of reverseSites) {
      const innerStart = f.range.end;
      const innerEnd = r.range.start;
      let inner: string;
      let spanLength: number;
      if (innerEnd >= innerStart) {
        inner = template.slice(innerStart, innerEnd);
        spanLength = innerEnd - innerStart;
      } else if (isCircular) {
        inner = template.slice(innerStart) + template.slice(0, innerEnd);
        spanLength = L - innerStart + innerEnd;
      } else {
        continue; // reverse primer sits upstream of the forward primer: no product
      }
      const sequence = forward.toUpperCase() + inner.toUpperCase() + reverseComplement(reverse.toUpperCase());
      if (sequence.length > maxLength) continue;
      products.push({
        sequence,
        length: sequence.length,
        templateRange: { start: f.range.start, end: r.range.end },
        forwardSite: f,
        reverseSite: r,
        annealingTemp: recommendedAnnealingTemp(f.tm, r.tm),
        productTm: meltingTemp(sequence.slice(0, 200)),
      });
    }
  }

  products.sort((a, b) => a.length - b.length);
  if (!products.length) {
    if (!forwardSites.length) warnings.push("The forward primer does not anneal to this template.");
    if (!reverseSites.length) warnings.push("The reverse primer does not anneal to this template.");
    if (forwardSites.length && reverseSites.length) warnings.push("Both primers anneal, but no reverse site lies downstream of a forward site.");
  } else if (products.length > 1) {
    warnings.push(`${products.length} products are possible; the primers are not specific to one site.`);
  }
  if ([...forwardAll, ...reverseAll].some((s) => s.mismatches > 0)) warnings.push("At least one primer anneals with mismatches.");
  return { products, forwardSites, reverseSites, warnings };
}

/** Q5/Phusion-style rule: anneal just above the lower primer Tm, capped at 72 °C. */
export function recommendedAnnealingTemp(tmA: number, tmB: number): number {
  const low = Math.min(tmA, tmB);
  const ta = Math.min(tmA, tmB) >= 72 ? 72 : low + 1;
  return Math.round(Math.max(45, Math.min(72, ta)) * 10) / 10;
}

// ---------------------------------------------------------------------------------------------
// Primer properties and design

export interface PrimerStats {
  sequence: string;
  length: number;
  tm: number;
  gc: number;
  /** G or C within the last five bases, which stabilises the 3' end */
  gcClamp: number;
  hairpin: StructureHit;
  selfDimer: StructureHit;
  longestRun: { base: string; length: number };
  warnings: string[];
}

export interface PrimerCriteria {
  minLength?: number;
  maxLength?: number;
  targetTm?: number;
  tmTolerance?: number;
  minGc?: number;
  maxGc?: number;
  maxRun?: number;
  /** reject primers whose hairpin or dimer ΔG is below this (kcal/mol) */
  maxStructureDg?: number;
  conditions?: Conditions;
}

export const DEFAULT_CRITERIA: Required<Omit<PrimerCriteria, "conditions">> & { conditions: Conditions } = {
  minLength: 18,
  maxLength: 30,
  targetTm: 60,
  tmTolerance: 5,
  minGc: 0.4,
  maxGc: 0.6,
  maxRun: 4,
  maxStructureDg: -9,
  conditions: DEFAULT_CONDITIONS,
};

export function primerStats(sequence: string, criteria: PrimerCriteria = {}): PrimerStats {
  const c = withDefaults(DEFAULT_CRITERIA, criteria);
  const seq = sequence.replace(/\s/g, "").toUpperCase();
  const tm = meltingTemp(seq, c.conditions);
  const gc = gcContent(seq);
  const last5 = seq.slice(-5);
  const gcClamp = [...last5].filter((b) => b === "G" || b === "C").length;
  const hp = hairpin(seq);
  const dimer = selfDimer(seq);
  const run = longestHomopolymer(seq);

  const warnings: string[] = [];
  if (seq.length < c.minLength) warnings.push(`Shorter than ${c.minLength} nt`);
  if (seq.length > c.maxLength) warnings.push(`Longer than ${c.maxLength} nt`);
  if (Math.abs(tm - c.targetTm) > c.tmTolerance) warnings.push(`Tm ${tm.toFixed(1)} °C is far from the ${c.targetTm} °C target`);
  if (gc < c.minGc) warnings.push(`GC ${(gc * 100).toFixed(0)}% is low`);
  if (gc > c.maxGc) warnings.push(`GC ${(gc * 100).toFixed(0)}% is high`);
  if (gcClamp === 0) warnings.push("No G or C in the last five bases");
  if (gcClamp >= 4) warnings.push("Four or more G/C in the last five bases encourages mispriming");
  if (run.length > c.maxRun) warnings.push(`Run of ${run.length} ${run.base}s`);
  if (hp.dg < c.maxStructureDg) warnings.push(`Stable hairpin (ΔG ${hp.dg.toFixed(1)} kcal/mol)`);
  if (dimer.dg < c.maxStructureDg) warnings.push(`Stable self-dimer (ΔG ${dimer.dg.toFixed(1)} kcal/mol)`);
  if (dimer.involves3Prime && dimer.dg < -5) warnings.push("Self-dimer involves the 3' end");

  return { sequence: seq, length: seq.length, tm, gc, gcClamp, hairpin: hp, selfDimer: dimer, longestRun: run, warnings };
}

export interface PrimerCandidate extends PrimerStats {
  /** where the annealing part sits on the template */
  range: Range;
  strand: 1 | -1;
  /** full oligo to order, including any tail */
  oligo: string;
  score: number;
}

export interface PrimerPair {
  forward: PrimerCandidate;
  reverse: PrimerCandidate;
  productLength: number;
  annealingTemp: number;
  tmDifference: number;
  crossDimer: StructureHit;
  score: number;
  warnings: string[];
}

export interface DesignOptions extends PrimerCriteria {
  /** bases of slack for where each primer may start (default 25) */
  searchWindow?: number;
  /** prepended to the forward oligo (restriction site, Gibson overlap…) */
  forwardTail?: string;
  /** prepended to the reverse oligo */
  reverseTail?: string;
  /** maximum pairs to return (default 5) */
  limit?: number;
}

/**
 * Design primer pairs that amplify `target` from `template`.
 *
 * The forward primer's 3' end lands at or just before `target.start`, and the reverse primer's
 * 3' end at or just after `target.end`, so the product always contains the whole target.
 */
export function designPrimers(template: string, target: Range, isCircular: boolean, opts: DesignOptions = {}): PrimerPair[] {
  const c = withDefaults(DEFAULT_CRITERIA, opts);
  const window = opts.searchWindow ?? 25;
  const limit = opts.limit ?? 5;
  const seq = template.toUpperCase();
  const L = seq.length;

  const forwards: PrimerCandidate[] = [];
  const reverses: PrimerCandidate[] = [];

  for (let offset = 0; offset <= window; offset++) {
    const end = target.start - offset; // 3' end of the forward primer, exclusive
    for (let len = c.minLength; len <= c.maxLength; len++) {
      const start = end - len;
      if (!isCircular && (start < 0 || end > L)) continue;
      const sub = sliceWrapped(seq, start, end, isCircular);
      if (!sub || /[^ACGT]/.test(sub)) continue;
      const stats = primerStats(sub, c);
      const candidate = toCandidate(stats, { start: wrapIndex(start, L), end: wrapIndex(end, L) }, 1, opts.forwardTail ?? "", c);
      if (candidate) forwards.push(candidate);
    }
  }

  for (let offset = 0; offset <= window; offset++) {
    const start = target.end + offset; // 3' end of the reverse primer sits here, reading leftwards
    for (let len = c.minLength; len <= c.maxLength; len++) {
      const end = start + len;
      if (!isCircular && (start < 0 || end > L)) continue;
      const sub = sliceWrapped(seq, start, end, isCircular);
      if (!sub || /[^ACGT]/.test(sub)) continue;
      const stats = primerStats(reverseComplement(sub), c);
      const candidate = toCandidate(stats, { start: wrapIndex(start, L), end: wrapIndex(end, L) }, -1, opts.reverseTail ?? "", c);
      if (candidate) reverses.push(candidate);
    }
  }

  forwards.sort((a, b) => b.score - a.score);
  reverses.sort((a, b) => b.score - a.score);

  const pairs: PrimerPair[] = [];
  for (const f of forwards.slice(0, 40)) {
    for (const r of reverses.slice(0, 40)) {
      const tmDifference = Math.abs(f.tm - r.tm);
      if (tmDifference > 4) continue;
      const cross = crossDimer(f.sequence, r.sequence);
      const productLength =
        (r.range.end >= f.range.start ? r.range.end - f.range.start : L - f.range.start + r.range.end) +
        (opts.forwardTail?.length ?? 0) +
        (opts.reverseTail?.length ?? 0);
      const warnings: string[] = [];
      if (cross.dg < c.maxStructureDg) warnings.push(`Primers form a dimer with each other (ΔG ${cross.dg.toFixed(1)} kcal/mol)`);
      if (tmDifference > 3) warnings.push(`Tm values differ by ${tmDifference.toFixed(1)} °C`);
      pairs.push({
        forward: f,
        reverse: r,
        productLength,
        annealingTemp: recommendedAnnealingTemp(f.tm, r.tm),
        tmDifference,
        crossDimer: cross,
        score: f.score + r.score - tmDifference * 2 - Math.max(0, -cross.dg - 6),
        warnings,
      });
    }
  }
  pairs.sort((a, b) => b.score - a.score);
  return pairs.slice(0, limit);
}

function toCandidate(
  stats: PrimerStats,
  range: Range,
  strand: 1 | -1,
  tail: string,
  c: Required<Omit<PrimerCriteria, "conditions">>,
): PrimerCandidate | null {
  // Hard filters: anything outside these is not worth ranking.
  if (Math.abs(stats.tm - c.targetTm) > c.tmTolerance) return null;
  if (stats.gc < c.minGc - 0.1 || stats.gc > c.maxGc + 0.1) return null;
  if (stats.longestRun.length > c.maxRun + 1) return null;

  let score = 100;
  score -= Math.abs(stats.tm - c.targetTm) * 4;
  score -= Math.abs(stats.gc - 0.5) * 50;
  score -= Math.max(0, -stats.hairpin.dg - 3) * 3;
  score -= Math.max(0, -stats.selfDimer.dg - 5) * 3;
  if (stats.selfDimer.involves3Prime) score -= 6;
  if (stats.gcClamp === 0) score -= 8;
  if (stats.gcClamp >= 4) score -= 6;
  score -= Math.max(0, stats.longestRun.length - c.maxRun) * 5;
  score -= Math.abs(stats.length - 20) * 0.5;

  return { ...stats, range, strand, oligo: tail + stats.sequence, score };
}

function sliceWrapped(seq: string, start: number, end: number, isCircular: boolean): string | null {
  const L = seq.length;
  if (end - start > L) return null;
  if (!isCircular) return start < 0 || end > L ? null : seq.slice(start, end);
  const s = wrapIndex(start, L);
  const e = wrapIndex(end, L);
  return e > s ? seq.slice(s, e) : seq.slice(s) + seq.slice(0, e);
}

/** Worst duplex between two different oligos. */
export function crossDimer(a: string, b: string): StructureHit {
  // Reuse the self-dimer search by checking a against the reverse complement of b.
  return selfDimerBetween(a.toUpperCase(), b.toUpperCase());
}

function selfDimerBetween(a: string, b: string): StructureHit {
  const rcB = reverseComplement(b);
  let best: StructureHit = { dg: 0, pairedLength: 0, involves3Prime: false, diagram: "" };
  for (let offset = -(a.length - 1); offset < rcB.length; offset++) {
    let runStart = -1;
    let runLength = 0;
    const flush = (endExclusive: number) => {
      if (runLength < 2) return;
      const matched = a.slice(runStart, endExclusive);
      const dg = pairedDg(matched);
      const near3 = endExclusive >= a.length - 2;
      if (dg < best.dg || (dg === best.dg && near3 && !best.involves3Prime)) {
        best = { dg, pairedLength: runLength, involves3Prime: near3, diagram: `${matched} (${runLength} bp)` };
      }
    };
    for (let i = 0; i < a.length; i++) {
      const j = i - offset;
      if (j >= 0 && j < rcB.length && a[i] === rcB[j]) {
        if (runStart === -1) { runStart = i; runLength = 0; }
        runLength++;
      } else {
        flush(i);
        runStart = -1;
        runLength = 0;
      }
    }
    flush(a.length);
  }
  return best;
}
