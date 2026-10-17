/**
 * Duplex thermodynamics: nearest-neighbor melting temperature, free energy, and the
 * self-structure checks primer design depends on.
 *
 * Parameters are SantaLucia (1998) unified nearest-neighbor values with the entropic salt
 * correction from the same paper, and the Owczarzy divalent-to-monovalent conversion for
 * magnesium. This is the same model IDT's OligoAnalyzer and SnapGene report.
 */

import { withDefaults } from "./options";
import { reverseComplement } from "./seq";

/** Gas constant, cal/(mol K). */
const R = 1.9872;
const KELVIN = 273.15;

interface NNParam {
  /** enthalpy, kcal/mol */
  h: number;
  /** entropy, cal/(mol K) */
  s: number;
}

/** Stacked pair -> ΔH/ΔS. Keyed by the two top-strand bases, 5'->3'. */
const NN: Readonly<Record<string, NNParam>> = {
  AA: { h: -7.9, s: -22.2 },
  TT: { h: -7.9, s: -22.2 },
  AT: { h: -7.2, s: -20.4 },
  TA: { h: -7.2, s: -21.3 },
  CA: { h: -8.5, s: -22.7 },
  TG: { h: -8.5, s: -22.7 },
  GT: { h: -8.4, s: -22.4 },
  AC: { h: -8.4, s: -22.4 },
  CT: { h: -7.8, s: -21.0 },
  AG: { h: -7.8, s: -21.0 },
  GA: { h: -8.2, s: -22.2 },
  TC: { h: -8.2, s: -22.2 },
  CG: { h: -10.6, s: -27.2 },
  GC: { h: -9.8, s: -24.4 },
  GG: { h: -8.0, s: -19.9 },
  CC: { h: -8.0, s: -19.9 },
};

const INIT_GC: NNParam = { h: 0.1, s: -2.8 };
const INIT_AT: NNParam = { h: 2.3, s: 4.1 };

export interface Conditions {
  /** total oligo strand concentration, M (default 0.25 µM, the usual PCR primer concentration) */
  oligoConc?: number;
  /** monovalent cation concentration, M (default 50 mM) */
  sodium?: number;
  /** magnesium concentration, M (default 0) */
  magnesium?: number;
  /** dNTP concentration, M; chelates magnesium so it is subtracted (default 0) */
  dntp?: number;
}

export const DEFAULT_CONDITIONS: Required<Conditions> = {
  oligoConc: 0.25e-6,
  sodium: 0.05,
  magnesium: 0,
  dntp: 0,
};

/**
 * Effective monovalent concentration in M, folding in free magnesium.
 *
 * Uses the standard equivalence [Na+]eq(mM) = [Na+] + 120 * sqrt([Mg2+] - [dNTP]), which is
 * defined in millimolar — a typical PCR buffer (50 mM Na+, 2 mM Mg2+, 0.2 mM dNTP) comes out
 * around 210 mM monovalent equivalent.
 */
export function effectiveSalt(c: Required<Conditions>): number {
  const sodiumMM = c.sodium * 1000;
  const freeMgMM = Math.max(0, (c.magnesium - c.dntp) * 1000);
  return Math.max(1e-4, (sodiumMM + 120 * Math.sqrt(freeMgMM)) / 1000);
}

/** Typical PCR buffer, for Tm values comparable to what a thermocycler actually sees. */
export const PCR_CONDITIONS: Required<Conditions> = {
  oligoConc: 0.25e-6,
  sodium: 0.05,
  magnesium: 0.002,
  dntp: 0.0002,
};

export interface DuplexEnergy {
  /** kcal/mol */
  dh: number;
  /** cal/(mol K) */
  ds: number;
  /** kcal/mol at 37 °C */
  dg37: number;
  tm: number;
}

function isPureDna(seq: string): boolean {
  return /^[ACGTacgt]+$/.test(seq);
}

/**
 * Nearest-neighbor ΔH/ΔS for a perfectly matched duplex of `seq` and its complement.
 * Non-ACGT characters (degenerate codes, gaps) make the result unreliable, so callers should
 * check `isPureDna` first; here they are skipped.
 */
function stack(seq: string): { dh: number; ds: number } {
  const s = seq.toUpperCase();
  let dh = 0;
  let ds = 0;
  for (let i = 0; i + 1 < s.length; i++) {
    const param = NN[s.slice(i, i + 2)];
    if (param) { dh += param.h; ds += param.s; }
  }
  const first = s[0]!;
  const last = s[s.length - 1]!;
  for (const terminal of [first, last]) {
    const init = terminal === "G" || terminal === "C" ? INIT_GC : INIT_AT;
    dh += init.h;
    ds += init.s;
  }
  return { dh, ds };
}

export function isSelfComplementary(seq: string): boolean {
  return seq.length > 0 && seq.toUpperCase() === reverseComplement(seq).toUpperCase();
}

/** Melting temperature in °C for an oligo annealing to its perfect complement. */
export function meltingTemp(seq: string, conditions: Conditions = {}): number {
  const c = withDefaults(DEFAULT_CONDITIONS, conditions);
  const clean = seq.replace(/[^A-Za-z]/g, "");
  if (clean.length < 2) return 0;
  if (!isPureDna(clean)) {
    // Degenerate or modified bases: fall back to the GC rule so the UI still shows something.
    return wallaceTm(clean);
  }
  const { dh, ds } = stack(clean);
  const salt = effectiveSalt(c);
  const dsSalt = ds + 0.368 * (clean.length - 1) * Math.log(salt);
  // Self-complementary oligos fold on themselves, so the concentration term loses the factor 4.
  const divisor = isSelfComplementary(clean) ? 1 : 4;
  const tm = (dh * 1000) / (dsSalt + R * Math.log(c.oligoConc / divisor)) - KELVIN;
  return Number.isFinite(tm) ? tm : 0;
}

/** Full thermodynamic summary of an oligo/complement duplex. */
export function duplexEnergy(seq: string, conditions: Conditions = {}): DuplexEnergy {
  const clean = seq.replace(/[^A-Za-z]/g, "");
  const { dh, ds } = stack(clean);
  const c = withDefaults(DEFAULT_CONDITIONS, conditions);
  const dsSalt = ds + 0.368 * Math.max(0, clean.length - 1) * Math.log(effectiveSalt(c));
  return {
    dh,
    ds: dsSalt,
    dg37: dh - ((37 + KELVIN) * dsSalt) / 1000,
    tm: meltingTemp(clean, conditions),
  };
}

/** The 2(A+T) + 4(G+C) rule. Only sensible below ~14 nt, but it never returns nonsense. */
export function wallaceTm(seq: string): number {
  let at = 0;
  let gc = 0;
  for (const ch of seq.toUpperCase()) {
    if (ch === "A" || ch === "T" || ch === "U") at++;
    else if (ch === "G" || ch === "C") gc++;
  }
  return 2 * at + 4 * gc;
}

// ---------------------------------------------------------------------------------------------
// Secondary structure

export interface StructureHit {
  /** ΔG at 37 °C, kcal/mol; more negative is more stable and therefore worse for a primer */
  dg: number;
  /** length of the longest contiguous base-paired stretch */
  pairedLength: number;
  /** true when the structure involves the 3' end, which is what blocks extension */
  involves3Prime: boolean;
  /** human-readable two-line diagram */
  diagram: string;
}

/** ΔG37 (kcal/mol) of a perfectly paired stretch, from the nearest-neighbor stack. */
export function pairedDg(seq: string): number {
  if (seq.length < 2) return 0;
  const { dh, ds } = stack(seq);
  return dh - ((37 + KELVIN) * ds) / 1000;
}

function pairedRunEnergy(a: string): { dg: number; length: number } {
  return { dg: pairedDg(a), length: a.length };
}

/**
 * Worst self-dimer: slide the oligo against its own reverse complement and score the best
 * contiguous complementary run. A cheap stand-in for a full partition function, matched to what
 * primer-design heuristics actually need (is there a stable 3' dimer?).
 */
export function selfDimer(seq: string): StructureHit {
  const s = seq.toUpperCase();
  const rc = reverseComplement(s);
  let best: StructureHit = { dg: 0, pairedLength: 0, involves3Prime: false, diagram: "" };

  for (let offset = -(s.length - 1); offset < s.length; offset++) {
    let runStart = -1;
    let runLength = 0;
    const flush = (endExclusive: number) => {
      if (runLength < 2) return;
      const matched = s.slice(runStart, endExclusive);
      const { dg } = pairedRunEnergy(matched);
      // A dimer anchored at the 3' end can be extended by polymerase: weight it as worse.
      const near3 = endExclusive >= s.length - 2;
      if (dg < best.dg || (dg === best.dg && near3 && !best.involves3Prime)) {
        best = {
          dg,
          pairedLength: runLength,
          involves3Prime: near3,
          diagram: dimerDiagram(s, rc, offset),
        };
      }
    };
    for (let i = 0; i < s.length; i++) {
      const j = i - offset;
      const paired = j >= 0 && j < rc.length && s[i] === rc[j];
      if (paired) {
        if (runStart === -1) { runStart = i; runLength = 0; }
        runLength++;
      } else {
        flush(i);
        runStart = -1;
        runLength = 0;
      }
    }
    flush(s.length);
  }
  return best;
}

function dimerDiagram(top: string, bottomRc: string, offset: number): string {
  const pad = Math.max(0, offset);
  const padBottom = Math.max(0, -offset);
  const line1 = `5'-${" ".repeat(padBottom)}${top}-3'`;
  const line2 = `3'-${" ".repeat(pad)}${[...bottomRc].reverse().join("")}-5'`;
  return `${line1}\n${line2}`;
}

/**
 * Worst hairpin: look for inverted repeats separated by a loop of at least three bases.
 * Returns ΔG of the stem; 0 when no hairpin of two or more pairs exists.
 */
export function hairpin(seq: string, minLoop = 3, minStem = 3): StructureHit {
  const s = seq.toUpperCase();
  let best: StructureHit = { dg: 0, pairedLength: 0, involves3Prime: false, diagram: "" };

  for (let i = 0; i < s.length; i++) {
    for (let j = i + minLoop + 2 * minStem; j <= s.length; j++) {
      // Grow a stem inward from (i, j-1).
      let stem = 0;
      while (
        i + stem < j - 1 - stem &&
        j - 1 - stem - (i + stem) - 1 >= minLoop &&
        complementaryBases(s[i + stem]!, s[j - 1 - stem]!)
      ) {
        stem++;
      }
      if (stem < minStem) continue;
      const stemSeq = s.slice(i, i + stem);
      const { dg } = pairedRunEnergy(stemSeq);
      // Loop closure penalty, approximated from the Jacobson-Stockmayer term.
      const loopSize = j - stem - (i + stem);
      const penalty = 1.75 * R * (37 + KELVIN) * Math.log(Math.max(loopSize, 3) / 3) / 1000 + 3.0;
      const total = dg + penalty;
      if (total < best.dg) {
        best = {
          dg: total,
          pairedLength: stem,
          involves3Prime: j >= s.length - 2,
          diagram: `${s.slice(i, i + stem)}…${s.slice(j - stem, j)} (loop ${loopSize} nt)`,
        };
      }
    }
  }
  return best;
}

function complementaryBases(a: string, b: string): boolean {
  return (a === "A" && b === "T") || (a === "T" && b === "A") || (a === "G" && b === "C") || (a === "C" && b === "G");
}

/** Longest run of a single base, which causes slippage and mispriming. */
export function longestHomopolymer(seq: string): { base: string; length: number } {
  let best = { base: "", length: 0 };
  let current = "";
  let run = 0;
  for (const ch of seq.toUpperCase()) {
    if (ch === current) run++;
    else { current = ch; run = 1; }
    if (run > best.length) best = { base: current, length: run };
  }
  return best;
}
