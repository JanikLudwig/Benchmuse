/**
 * Core sequence operations: complementing, slicing (circular-aware), translation, ORF finding
 * and motif search with IUPAC degeneracy.
 */

import { complementCode, couldMatch, isUnambiguous, matchesPattern } from "./alphabet";
import { rangeLength, segments, wrapIndex, type Range } from "./range";

export type SeqKind = "dna" | "aa";

export function reverseComplement(seq: string): string {
  let out = "";
  for (let i = seq.length - 1; i >= 0; i--) out += complementCode(seq[i]!);
  return out;
}

export function complement(seq: string): string {
  let out = "";
  for (const ch of seq) out += complementCode(ch);
  return out;
}

/** Extract the bases a range covers, wrapping the origin on circular sequences. */
export function sliceRange(seq: string, range: Range, isCircular: boolean): string {
  return segments(range, seq.length, isCircular)
    .map((s) => seq.slice(s.start, s.end))
    .join("");
}

/** Bases of a feature in its own 5'->3' direction (reverse-complemented when on the bottom strand). */
export function featureSequence(seq: string, range: Range, strand: number, isCircular: boolean): string {
  const bases = sliceRange(seq, range, isCircular);
  return strand === -1 ? reverseComplement(bases) : bases;
}

export function gcContent(seq: string): number {
  if (!seq.length) return 0;
  let gc = 0;
  let counted = 0;
  for (const ch of seq.toUpperCase()) {
    if (ch === "G" || ch === "C" || ch === "S") { gc++; counted++; }
    else if (ch === "A" || ch === "T" || ch === "U" || ch === "W") counted++;
  }
  return counted ? gc / counted : 0;
}

export function baseCounts(seq: string): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const ch of seq.toUpperCase()) counts[ch] = (counts[ch] ?? 0) + 1;
  return counts;
}

// ---------------------------------------------------------------------------------------------
// Translation

/**
 * NCBI genetic code tables. Codons are indexed in TCAG order:
 * index = 16*b1 + 4*b2 + b3 with T=0, C=1, A=2, G=3.
 */
export interface GeneticCode {
  id: number;
  name: string;
  /** 64 amino-acid letters in TCAG codon order */
  aminoAcids: string;
  /** 64 flags: "M" = start codon, "-" = not a start */
  starts: string;
}

export const GENETIC_CODES: Readonly<Record<number, GeneticCode>> = {
  1: {
    id: 1,
    name: "Standard",
    aminoAcids: "FFLLSSSSYY**CC*WLLLLPPPPHHQQRRRRIIIMTTTTNNKKSSRRVVVVAAAADDEEGGGG",
    starts: "---M------**--*----M---------------M----------------------------",
  },
  2: {
    id: 2,
    name: "Vertebrate mitochondrial",
    aminoAcids: "FFLLSSSSYY**CCWWLLLLPPPPHHQQRRRRIIMMTTTTNNKKSS**VVVVAAAADDEEGGGG",
    starts: "----------**--------------------MMMM----------**---M------------",
  },
  11: {
    id: 11,
    name: "Bacterial, archaeal and plant plastid",
    aminoAcids: "FFLLSSSSYY**CC*WLLLLPPPPHHQQRRRRIIIMTTTTNNKKSSRRVVVVAAAADDEEGGGG",
    starts: "---M------**--*----M------------MMMM---------------M------------",
  },
};

const BASE_INDEX: Readonly<Record<string, number>> = { T: 0, U: 0, C: 1, A: 2, G: 3 };

function codonIndex(codon: string): number | null {
  const a = BASE_INDEX[codon[0]!.toUpperCase()];
  const b = BASE_INDEX[codon[1]!.toUpperCase()];
  const c = BASE_INDEX[codon[2]!.toUpperCase()];
  if (a === undefined || b === undefined || c === undefined) return null;
  return a * 16 + b * 4 + c;
}

export function translateCodon(codon: string, code: GeneticCode = GENETIC_CODES[1]!): string {
  if (codon.length < 3) return "";
  const idx = codonIndex(codon);
  if (idx === null) return "X"; // degenerate or non-standard character
  return code.aminoAcids[idx]!;
}

export function isStartCodon(codon: string, code: GeneticCode = GENETIC_CODES[1]!): boolean {
  const idx = codonIndex(codon);
  return idx !== null && code.starts[idx] === "M";
}

export interface TranslateOptions {
  code?: GeneticCode;
  /** stop at the first stop codon instead of translating through it */
  toStop?: boolean;
  /** render the first codon as M when it is a valid alternative start (ATG, GTG, TTG…) */
  initiatorMet?: boolean;
}

export function translate(seq: string, opts: TranslateOptions = {}): string {
  const code = opts.code ?? GENETIC_CODES[1]!;
  let protein = "";
  for (let i = 0; i + 3 <= seq.length; i += 3) {
    const codon = seq.slice(i, i + 3);
    let aa = translateCodon(codon, code);
    if (i === 0 && opts.initiatorMet && isStartCodon(codon, code)) aa = "M";
    if (aa === "*" && opts.toStop) break;
    protein += aa;
  }
  return protein;
}

// ---------------------------------------------------------------------------------------------
// ORFs

export interface Orf {
  range: Range;
  strand: 1 | -1;
  /** reading frame 0-2 relative to the start of the top strand */
  frame: number;
  /** amino-acid length, excluding the stop codon */
  aaLength: number;
  protein: string;
  hasStop: boolean;
}

export interface OrfOptions {
  code?: GeneticCode;
  /** shortest protein to report, in amino acids */
  minAaLength?: number;
  /** require a start codon; when false, report stop-to-stop reading frames */
  requireStart?: boolean;
  strands?: "both" | "forward" | "reverse";
}

/**
 * Find open reading frames. On circular sequences frames continue across the origin, so a CDS
 * that spans the origin of a plasmid is reported as one ORF rather than two fragments.
 */
export function findOrfs(seq: string, isCircular: boolean, opts: OrfOptions = {}): Orf[] {
  const code = opts.code ?? GENETIC_CODES[1]!;
  const minAa = opts.minAaLength ?? 30;
  const requireStart = opts.requireStart ?? true;
  const strands: (1 | -1)[] = opts.strands === "forward" ? [1] : opts.strands === "reverse" ? [-1] : [1, -1];
  const L = seq.length;
  if (L < 3) return [];
  const out: Orf[] = [];

  for (const strand of strands) {
    // Scan the strand 5'->3'; for the bottom strand that is the reverse complement.
    const scanned = strand === 1 ? seq : reverseComplement(seq);
    // On a circular sequence a frame can run past the end; append a copy minus one codon so
    // reading frames continue through the origin without duplicating a full lap.
    const extended = isCircular ? scanned + scanned.slice(0, Math.max(0, Math.min(L, 3000))) : scanned;

    for (let frame = 0; frame < 3; frame++) {
      let orfStart: number | null = null;
      for (let i = frame; i + 3 <= extended.length; i += 3) {
        if (isCircular && i >= L) {
          // Past one full lap: only finish ORFs that began before the origin.
          if (orfStart === null) break;
        }
        const codon = extended.slice(i, i + 3);
        const aa = translateCodon(codon, code);
        if (orfStart === null) {
          const opens = requireStart ? isStartCodon(codon, code) : aa !== "*";
          if (opens) orfStart = i;
          continue;
        }
        if (aa === "*") {
          pushOrf(out, scanned, orfStart, i + 3, frame, strand, L, isCircular, code, minAa, true);
          orfStart = null;
        }
      }
      // A frame that reaches the end without a stop is still worth reporting on linear molecules.
      if (orfStart !== null && !isCircular) {
        const end = orfStart + Math.floor((scanned.length - orfStart) / 3) * 3;
        pushOrf(out, scanned, orfStart, end, frame, strand, L, isCircular, code, minAa, false);
      }
    }
  }
  return out.sort((a, b) => b.aaLength - a.aaLength);
}

function pushOrf(
  out: Orf[],
  scanned: string,
  start: number,
  end: number,
  frame: number,
  strand: 1 | -1,
  L: number,
  isCircular: boolean,
  code: GeneticCode,
  minAa: number,
  hasStop: boolean,
): void {
  const nt = end - start;
  const aaLength = Math.floor(nt / 3) - (hasStop ? 1 : 0);
  if (aaLength < minAa) return;
  const bases = sliceScanned(scanned, start, end, L, isCircular);
  const protein = translate(bases, { code, toStop: true, initiatorMet: true });
  // Map scanned-strand coordinates back onto the top strand.
  const range: Range =
    strand === 1
      ? { start: wrapIndex(start, L), end: isCircular ? wrapIndex(end, L) : Math.min(end, L) }
      : { start: wrapIndex(L - end, L), end: isCircular ? wrapIndex(L - start, L) : Math.max(0, L - start) };
  out.push({ range, strand, frame, aaLength, protein, hasStop });
}

function sliceScanned(scanned: string, start: number, end: number, L: number, isCircular: boolean): string {
  if (!isCircular || end <= L) return scanned.slice(start, end);
  return scanned.slice(start, L) + scanned.slice(0, end - L);
}

// ---------------------------------------------------------------------------------------------
// Motif search

export interface Match {
  range: Range;
  strand: 1 | -1;
  /** number of positions where the subject and pattern differ (0 for exact matches) */
  mismatches: number;
}

export interface SearchOptions {
  /** search the reverse strand as well */
  bothStrands?: boolean;
  /** allow up to this many mismatched positions */
  maxMismatches?: number;
  /**
   * How to compare degenerate codes. "pattern" (default) lets the pattern be degenerate but
   * requires the subject to be compatible with it; "either" counts any possible shared base,
   * which is what you want when the *subject* contains Ns.
   */
  degeneracy?: "pattern" | "either";
}

/**
 * Find every occurrence of `pattern` in `seq`, including matches that span the origin of a
 * circular sequence. Returns top-strand coordinates; reverse-strand hits are reported on the
 * range they occupy with strand -1.
 */
export function findMatches(seq: string, pattern: string, isCircular: boolean, opts: SearchOptions = {}): Match[] {
  const maxMismatches = opts.maxMismatches ?? 0;
  const degeneracy = opts.degeneracy ?? "pattern";
  const L = seq.length;
  const P = pattern.length;
  if (!P || !L || P > (isCircular ? L : L)) return [];

  const out: Match[] = [];
  const scan = (needle: string, strand: 1 | -1) => {
    const limit = isCircular ? L : L - P + 1;
    for (let i = 0; i < limit; i++) {
      let mismatches = 0;
      let ok = true;
      for (let j = 0; j < P; j++) {
        const pos = isCircular ? wrapIndex(i + j, L) : i + j;
        if (!isCircular && pos >= L) { ok = false; break; }
        const subject = seq[pos]!;
        const expected = needle[j]!;
        const matched = degeneracy === "either" ? couldMatch(subject, expected) : matchesPattern(subject, expected);
        if (!matched && ++mismatches > maxMismatches) { ok = false; break; }
      }
      if (!ok) continue;
      const end = isCircular ? wrapIndex(i + P, L) : i + P;
      out.push({ range: { start: i, end: P === L && isCircular ? i : end }, strand, mismatches });
    }
  };

  scan(pattern, 1);
  if (opts.bothStrands) scan(reverseComplement(pattern), -1);
  return out.sort((a, b) => a.range.start - b.range.start || a.strand - b.strand);
}

/** True when a pattern contains only unambiguous bases (so it can use a fast exact search). */
export function isExactPattern(pattern: string): boolean {
  return [...pattern].every(isUnambiguous);
}

/**
 * Longest common prefix/suffix overlap between the end of `a` and the start of `b`, used by
 * Gibson assembly and by circular-contig detection in assembly.
 */
export function overlapLength(a: string, b: string, minLength: number, maxLength: number): number {
  const max = Math.min(maxLength, a.length, b.length);
  for (let len = max; len >= minLength; len--) {
    if (a.slice(a.length - len).toUpperCase() === b.slice(0, len).toUpperCase()) return len;
  }
  return 0;
}

// ---------------------------------------------------------------------------------------------
// Input normalisation

export const MAX_SEQUENCE_LENGTH = 1_000_000;

const DNA_ALPHABET = /^[ACGTURYSWKMBDHVN]*$/i;
const AA_ALPHABET = /^[ACDEFGHIKLMNPQRSTVWYBZXJUO*]*$/i;

/**
 * Strip the whitespace and digits found in pasted GenBank/FASTA bodies, then check the alphabet.
 * Case is preserved, because lowercase often marks regions a scientist cares about.
 */
export function normalizeSequence(raw: string, kind: SeqKind): { ok: true; value: string } | { ok: false; error: string } {
  const value = raw.replace(/[\s\d]/g, "");
  if (value.length > MAX_SEQUENCE_LENGTH) return { ok: false, error: `sequence exceeds ${MAX_SEQUENCE_LENGTH} residues` };
  const alphabet = kind === "dna" ? DNA_ALPHABET : AA_ALPHABET;
  if (!alphabet.test(value)) {
    const bad = [...value].find((c) => !alphabet.test(c));
    return { ok: false, error: `invalid ${kind === "dna" ? "nucleotide" : "amino acid"} character '${bad}'` };
  }
  return { ok: true, value };
}
