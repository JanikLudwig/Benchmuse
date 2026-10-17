/**
 * IUPAC nucleotide and amino-acid alphabets.
 *
 * Degenerate nucleotide codes are represented as 4-bit masks (A=1, C=2, G=4, T=8) so that
 * "does code X match code Y" is a bitwise AND — the operation enzyme recognition, primer
 * binding and guide matching all depend on.
 */

export const A = 1;
export const C = 2;
export const G = 4;
export const T = 8;

/** code -> 4-bit base mask. Uppercase only; callers normalize case. */
export const IUPAC_MASK: Readonly<Record<string, number>> = {
  A, C, G, T,
  U: T,
  R: A | G,
  Y: C | T,
  S: C | G,
  W: A | T,
  K: G | T,
  M: A | C,
  B: C | G | T,
  D: A | G | T,
  H: A | C | T,
  V: A | C | G,
  N: A | C | G | T,
};

/** mask -> canonical IUPAC code (the inverse of IUPAC_MASK). */
export const MASK_CODE: Readonly<Record<number, string>> = {
  [A]: "A",
  [C]: "C",
  [G]: "G",
  [T]: "T",
  [A | G]: "R",
  [C | T]: "Y",
  [C | G]: "S",
  [A | T]: "W",
  [G | T]: "K",
  [A | C]: "M",
  [C | G | T]: "B",
  [A | G | T]: "D",
  [A | C | T]: "H",
  [A | C | G]: "V",
  [A | C | G | T]: "N",
};

export function maskOf(code: string): number {
  return IUPAC_MASK[code.toUpperCase()] ?? 0;
}

/**
 * True when `subject` is compatible with `pattern`: every base the subject could be is one the
 * pattern allows. Unambiguous A still matches pattern N, but ambiguous N does not match A.
 */
export function matchesPattern(subject: string, pattern: string): boolean {
  const s = maskOf(subject);
  const p = maskOf(pattern);
  return s !== 0 && p !== 0 && (s & ~p) === 0;
}

/** True when the two codes could represent the same base (masks overlap). */
export function couldMatch(a: string, b: string): boolean {
  return (maskOf(a) & maskOf(b)) !== 0;
}

export function isUnambiguous(code: string): boolean {
  const m = maskOf(code);
  return m === A || m === C || m === G || m === T;
}

const COMPLEMENT_MASK = (mask: number): number =>
  ((mask & A) ? T : 0) | ((mask & T) ? A : 0) | ((mask & C) ? G : 0) | ((mask & G) ? C : 0);

/** Case-preserving complement of a single code; unknown characters pass through unchanged. */
export function complementCode(code: string): string {
  const upper = code.toUpperCase();
  const mask = IUPAC_MASK[upper];
  if (mask === undefined) return code;
  // U complements to A, and conventionally stays in the DNA alphabet.
  const comp = MASK_CODE[COMPLEMENT_MASK(mask)] ?? "N";
  return code === upper ? comp : comp.toLowerCase();
}

export const DNA_CODES = "ACGTURYSWKMBDHVN";
export const AA_CODES = "ACDEFGHIKLMNPQRSTVWYBZXJUO*";

const DNA_SET = new Set(DNA_CODES);
const AA_SET = new Set(AA_CODES);

export function isDnaCode(ch: string): boolean {
  return DNA_SET.has(ch.toUpperCase());
}

export function isAaCode(ch: string): boolean {
  return AA_SET.has(ch.toUpperCase());
}

/**
 * Guess whether a residue string is nucleotide or protein. Short unambiguous strings like "MA"
 * are genuinely ambiguous; we call anything that is >85% ACGTUN and at least 10 long nucleotide,
 * which is the heuristic every sequence tool uses for pasted text.
 */
export function guessKind(residues: string): "dna" | "aa" {
  const letters = residues.replace(/[^A-Za-z]/g, "").toUpperCase();
  if (!letters.length) return "dna";
  let acgtun = 0;
  for (const ch of letters) if (ch === "A" || ch === "C" || ch === "G" || ch === "T" || ch === "U" || ch === "N") acgtun++;
  const ratio = acgtun / letters.length;
  if (letters.length < 10) return ratio === 1 ? "dna" : "aa";
  return ratio > 0.85 ? "dna" : "aa";
}
