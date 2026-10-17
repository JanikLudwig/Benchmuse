/**
 * Pairwise sequence alignment with affine gaps, plus seed-and-extend for aligning short reads
 * against long (and circular) references.
 *
 * The DP is Gotoh's three-matrix formulation. Large problems are first reduced by k-mer
 * seeding so that a 1 kb Sanger read can be placed in a 50 kb reference without filling a
 * 50-million-cell matrix.
 */

import { couldMatch, isUnambiguous } from "./alphabet";
import { wrapIndex } from "./range";
import { reverseComplement } from "./seq";

export interface ScoringScheme {
  match: number;
  mismatch: number;
  /** cost of opening a gap, applied in addition to one extension */
  gapOpen: number;
  gapExtend: number;
  /** score for a position where either base is ambiguous but compatible (N, R, Y…) */
  ambiguous: number;
}

export const DNA_SCORING: ScoringScheme = {
  match: 2,
  mismatch: -3,
  gapOpen: -6,
  gapExtend: -1,
  ambiguous: 0,
};

export type AlignMode =
  /** both sequences aligned end to end */
  | "global"
  /** best-scoring local region of each (Smith-Waterman) */
  | "local"
  /** the whole query is aligned, but the reference may extend past both ends */
  | "glocal";

/** CIGAR-style run-length encoding of an alignment path. */
export type CigarOp = "M" | "I" | "D";
export interface CigarRun {
  op: CigarOp;
  length: number;
}

export interface Alignment {
  score: number;
  /** half-open span of the reference that is aligned */
  refStart: number;
  refEnd: number;
  /** half-open span of the query that is aligned */
  queryStart: number;
  queryEnd: number;
  cigar: CigarRun[];
  /** gapped strings, "-" for gaps */
  alignedRef: string;
  alignedQuery: string;
  identity: number;
  matches: number;
  mismatches: number;
  gaps: number;
}

function scorePair(a: string, b: string, s: ScoringScheme): number {
  const A = a.toUpperCase();
  const B = b.toUpperCase();
  if (A === B) return isUnambiguous(A) ? s.match : s.ambiguous;
  if (!isUnambiguous(A) || !isUnambiguous(B)) return couldMatch(A, B) ? s.ambiguous : s.mismatch;
  return s.mismatch;
}

const NEG = -1e9;

/**
 * Align two sequences with affine gap penalties.
 *
 * `ref` is the first sequence and `query` the second; in glocal mode the query is aligned in
 * full while the reference may overhang at either end.
 */
export function alignPair(ref: string, query: string, mode: AlignMode = "global", scoring: ScoringScheme = DNA_SCORING): Alignment {
  const n = ref.length;
  const m = query.length;
  if (!n || !m) return emptyAlignment();

  // Row-wise DP. Traceback is stored as 2 bits per cell per matrix, packed into one byte.
  const size = (n + 1) * (m + 1);
  const tb = new Uint8Array(size);
  let prevM = new Float64Array(m + 1);
  let prevX = new Float64Array(m + 1);
  let prevY = new Float64Array(m + 1);
  let currM = new Float64Array(m + 1);
  let currX = new Float64Array(m + 1);
  let currY = new Float64Array(m + 1);

  const freeRefStart = mode !== "global";
  const freeQueryStart = mode === "local";

  prevM[0] = 0;
  prevX[0] = NEG;
  prevY[0] = NEG;
  for (let j = 1; j <= m; j++) {
    prevM[j] = NEG;
    prevX[j] = NEG;
    prevY[j] = freeQueryStart ? 0 : scoring.gapOpen + scoring.gapExtend * j;
    tb[j] = 2 << 4; // came from Y
  }

  let best = { score: NEG, i: 0, j: 0 };
  for (let i = 1; i <= n; i++) {
    currM[0] = NEG;
    currX[0] = freeRefStart ? 0 : scoring.gapOpen + scoring.gapExtend * i;
    currY[0] = NEG;
    tb[i * (m + 1)] = 1 << 2;

    const refBase = ref[i - 1]!;
    for (let j = 1; j <= m; j++) {
      const idx = i * (m + 1) + j;
      const s = scorePair(refBase, query[j - 1]!, scoring);

      // M: extend the best of the three states diagonally.
      const fromM = prevM[j - 1]! + s;
      const fromX = prevX[j - 1]! + s;
      const fromY = prevY[j - 1]! + s;
      let mScore = fromM;
      let mFrom = 0;
      if (fromX > mScore) { mScore = fromX; mFrom = 1; }
      if (fromY > mScore) { mScore = fromY; mFrom = 2; }
      if (mode === "local" && mScore < 0) { mScore = 0; mFrom = 3; }

      // X: gap in the query (consume a reference base).
      const xOpen = prevM[j]! + scoring.gapOpen + scoring.gapExtend;
      const xExtend = prevX[j]! + scoring.gapExtend;
      const xScore = Math.max(xOpen, xExtend);

      // Y: gap in the reference (consume a query base).
      const yOpen = currM[j - 1]! + scoring.gapOpen + scoring.gapExtend;
      const yExtend = currY[j - 1]! + scoring.gapExtend;
      const yScore = Math.max(yOpen, yExtend);

      currM[j] = mScore;
      currX[j] = xScore;
      currY[j] = yScore;
      tb[idx] = mFrom | ((xExtend >= xOpen ? 1 : 0) << 2) | ((yExtend >= yOpen ? 1 : 0) << 3);

      if (mode === "local") {
        if (mScore > best.score) best = { score: mScore, i, j };
      } else if (mode === "glocal" && j === m) {
        // Query fully consumed: the reference may end anywhere.
        if (mScore > best.score) best = { score: mScore, i, j };
      }
    }
    [prevM, currM] = [currM, prevM];
    [prevX, currX] = [currX, prevX];
    [prevY, currY] = [currY, prevY];
  }

  if (mode === "global") best = { score: Math.max(prevM[m]!, prevX[m]!, prevY[m]!), i: n, j: m };
  else if (mode === "glocal" && best.score === NEG) best = { score: prevM[m]!, i: n, j: m };
  if (best.score === NEG) return emptyAlignment();

  return traceback(ref, query, tb, m, best, mode, scoring);
}

function traceback(
  ref: string,
  query: string,
  tb: Uint8Array,
  m: number,
  best: { score: number; i: number; j: number },
  mode: AlignMode,
  scoring: ScoringScheme,
): Alignment {
  let i = best.i;
  let j = best.j;
  const refOut: string[] = [];
  const queryOut: string[] = [];
  const runs: CigarRun[] = [];
  const push = (op: CigarOp) => {
    const last = runs[runs.length - 1];
    if (last && last.op === op) last.length++;
    else runs.push({ op, length: 1 });
  };

  // Walk back through whichever state the cell came from. `state` 0=M, 1=X, 2=Y.
  let state = 0;
  while (i > 0 && j > 0) {
    const flags = tb[i * (m + 1) + j]!;
    if (state === 0) {
      const from = flags & 3;
      if (mode === "local" && from === 3) break;
      refOut.push(ref[i - 1]!);
      queryOut.push(query[j - 1]!);
      push("M");
      i--;
      j--;
      state = from === 3 ? 0 : from;
    } else if (state === 1) {
      refOut.push(ref[i - 1]!);
      queryOut.push("-");
      push("D");
      const extended = (flags >> 2) & 1;
      i--;
      state = extended ? 1 : 0;
    } else {
      refOut.push("-");
      queryOut.push(query[j - 1]!);
      push("I");
      const extended = (flags >> 3) & 1;
      j--;
      state = extended ? 2 : 0;
    }
  }
  if (mode === "global") {
    while (i > 0) { refOut.push(ref[i - 1]!); queryOut.push("-"); push("D"); i--; }
    while (j > 0) { refOut.push("-"); queryOut.push(query[j - 1]!); push("I"); j--; }
  }

  refOut.reverse();
  queryOut.reverse();
  runs.reverse();
  const alignedRef = refOut.join("");
  const alignedQuery = queryOut.join("");

  let matches = 0;
  let mismatches = 0;
  let gaps = 0;
  for (let k = 0; k < alignedRef.length; k++) {
    const a = alignedRef[k]!;
    const b = alignedQuery[k]!;
    if (a === "-" || b === "-") gaps++;
    else if (scorePair(a, b, scoring) > scoring.mismatch) matches++;
    else mismatches++;
  }
  const columns = alignedRef.length || 1;

  return {
    score: best.score,
    refStart: i,
    refEnd: best.i,
    queryStart: j,
    queryEnd: best.j,
    cigar: runs,
    alignedRef,
    alignedQuery,
    identity: matches / columns,
    matches,
    mismatches,
    gaps,
  };
}

function emptyAlignment(): Alignment {
  return {
    score: 0, refStart: 0, refEnd: 0, queryStart: 0, queryEnd: 0, cigar: [],
    alignedRef: "", alignedQuery: "", identity: 0, matches: 0, mismatches: 0, gaps: 0,
  };
}

export function cigarString(cigar: readonly CigarRun[]): string {
  return cigar.map((r) => `${r.length}${r.op}`).join("");
}

// ---------------------------------------------------------------------------------------------
// Seed and extend, for placing reads in long references

interface Seed {
  refPos: number;
  queryPos: number;
  length: number;
}

/** Index every k-mer position of the reference. */
function kmerIndex(ref: string, k: number): Map<string, number[]> {
  const index = new Map<string, number[]>();
  const upper = ref.toUpperCase();
  for (let i = 0; i + k <= upper.length; i++) {
    const kmer = upper.slice(i, i + k);
    if (kmer.includes("N")) continue;
    const list = index.get(kmer);
    if (list) {
      // Cap the posting list: highly repetitive k-mers add cost without adding information.
      if (list.length < 64) list.push(i);
    } else index.set(kmer, [i]);
  }
  return index;
}

/**
 * Find diagonal chains of shared k-mers. Returns candidate (refStart, band) regions, best first.
 */
function findSeedChains(ref: string, query: string, k: number): { refStart: number; refEnd: number; votes: number }[] {
  const index = kmerIndex(ref, k);
  const upperQuery = query.toUpperCase();
  // Vote per diagonal (refPos - queryPos), bucketed to tolerate small indels.
  const BUCKET = 32;
  const votes = new Map<number, { count: number; minRef: number; maxRef: number }>();
  for (let j = 0; j + k <= upperQuery.length; j += Math.max(1, Math.floor(k / 2))) {
    const positions = index.get(upperQuery.slice(j, j + k));
    if (!positions) continue;
    for (const refPos of positions) {
      const diagonal = Math.floor((refPos - j) / BUCKET);
      const entry = votes.get(diagonal) ?? { count: 0, minRef: refPos, maxRef: refPos };
      entry.count++;
      entry.minRef = Math.min(entry.minRef, refPos);
      entry.maxRef = Math.max(entry.maxRef, refPos);
      votes.set(diagonal, entry);
    }
  }
  return [...votes.entries()]
    .map(([diagonal, v]) => ({
      refStart: Math.max(0, Math.min(v.minRef, diagonal * BUCKET)),
      refEnd: Math.min(ref.length, v.maxRef + query.length),
      votes: v.count,
    }))
    .sort((a, b) => b.votes - a.votes)
    .slice(0, 6);
}

export interface ReadAlignment extends Alignment {
  /** 1 when the query aligned as given, -1 when its reverse complement aligned */
  strand: 1 | -1;
  /** query as aligned (reverse-complemented when strand is -1) */
  orientedQuery: string;
  /** reference coordinates, already mapped back onto a circular reference if needed */
  refStartOnReference: number;
  refEndOnReference: number;
  /** true when the alignment runs through the origin of a circular reference */
  spansOrigin: boolean;
}

export interface AlignReadOptions {
  scoring?: ScoringScheme;
  /** k-mer size for seeding (default 12) */
  seedSize?: number;
  /** try the reverse complement too (default true) */
  bothStrands?: boolean;
  /** force full DP rather than seeding; useful for short references */
  exhaustive?: boolean;
}

/**
 * Align a read against a reference, trying both strands and allowing the alignment to cross the
 * origin of a circular reference.
 */
export function alignRead(reference: string, read: string, isCircular: boolean, opts: AlignReadOptions = {}): ReadAlignment | null {
  const scoring = opts.scoring ?? DNA_SCORING;
  const seedSize = opts.seedSize ?? 12;
  const strands: (1 | -1)[] = opts.bothStrands === false ? [1] : [1, -1];
  const L = reference.length;
  if (!L || !read.length) return null;

  // A circular reference is searched as two laps so reads crossing the origin align contiguously.
  const searchRef = isCircular ? reference + reference.slice(0, Math.min(L, read.length * 2)) : reference;

  let best: { alignment: Alignment; strand: 1 | -1; oriented: string } | null = null;
  for (const strand of strands) {
    const oriented = strand === 1 ? read : reverseComplement(read);
    const candidates =
      opts.exhaustive || searchRef.length * oriented.length < 4_000_000
        ? [{ refStart: 0, refEnd: searchRef.length, votes: 0 }]
        : findSeedChains(searchRef, oriented, seedSize);
    if (!candidates.length) continue;

    for (const candidate of candidates) {
      const pad = Math.min(200, oriented.length);
      const from = Math.max(0, candidate.refStart - pad);
      const to = Math.min(searchRef.length, candidate.refEnd + pad);
      const window = searchRef.slice(from, to);
      if (!window.length) continue;
      const alignment = alignPair(window, oriented, "glocal", scoring);
      if (!alignment.alignedRef.length) continue;
      const shifted: Alignment = { ...alignment, refStart: alignment.refStart + from, refEnd: alignment.refEnd + from };
      if (!best || shifted.score > best.alignment.score) best = { alignment: shifted, strand, oriented };
    }
  }
  if (!best) return null;

  const { alignment, strand, oriented } = best;
  const spansOrigin = isCircular && alignment.refEnd > L;
  return {
    ...alignment,
    strand,
    orientedQuery: oriented,
    refStartOnReference: isCircular ? wrapIndex(alignment.refStart, L) : alignment.refStart,
    refEndOnReference: isCircular ? wrapIndex(alignment.refEnd, L) || (alignment.refEnd > 0 ? L : 0) : alignment.refEnd,
    spansOrigin,
  };
}
