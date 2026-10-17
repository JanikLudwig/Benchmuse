/**
 * A realistic demo construct used by tests and by the app's seed data.
 *
 * Built from published parts (T7 expression cassette, pUC19 polylinker, avGFP coding sequence)
 * so that tool output can be checked against what a scientist would expect in the lab.
 */

import { getPart } from "./features/library";
import { translate } from "./seq";

/** Aequorea victoria green fluorescent protein (UniProt P42212). */
export const GFP_PROTEIN =
  "MSKGEELFTGVVPILVELDGDVNGHKFSVSGEGEGDATYGKLTLKFICTTGKLPVPWPTLVTTFSYGVQCFSRYPDHMKQHDFFKSAMPEGYVQERTIFFKDDGNYKTRAEVKFEGDTLVNRIELKGIDFKEDGNILGHKLEYNYNSHNVYIMADKQKNGIKVNFKIRHNIEDGSVQLADHYQQNTPIGDGPVLLPDNHYLSTQSALSKDPNEKRDHMVLLEFVTAAGITHGMDELYK";

/** E. coli high-expression codons, one per amino acid. */
const CODON: Readonly<Record<string, string>> = {
  A: "GCG", R: "CGT", N: "AAC", D: "GAT", C: "TGC", Q: "CAG", E: "GAA", G: "GGC", H: "CAT", I: "ATT",
  L: "CTG", K: "AAA", M: "ATG", F: "TTT", P: "CCG", S: "AGC", T: "ACC", W: "TGG", Y: "TAT", V: "GTG",
};

export function backTranslate(protein: string): string {
  return [...protein].map((aa) => CODON[aa] ?? "NNN").join("");
}

export const GFP_CDS = backTranslate(GFP_PROTEIN) + "TAA";

/** The pUC19 polylinker: EcoRI, SacI, KpnI, SmaI/XmaI, BamHI, XbaI, SalI, PstI, SphI, HindIII. */
export const PUC19_MCS = "GAATTCGAGCTCGGTACCCGGGGATCCTCTAGAGTCGACCTGCAGGCATGCAAGCTT";

const partSeq = (name: string): string => {
  const p = getPart(name);
  if (!p) throw new Error(`unknown part ${name}`);
  return p.sequence;
};

/** Deterministic filler with balanced composition and no accidental common sites. */
function filler(length: number, seed: number): string {
  let x = seed >>> 0;
  let out = "";
  while (out.length < length) {
    x = (Math.imul(x, 1103515245) + 12345) >>> 0;
    out += "ACGT"[x >>> 30];
  }
  return out.slice(0, length);
}

interface Segment {
  name: string;
  type: string;
  seq: string;
  strand?: 1 | -1;
}

const SEGMENTS: Segment[] = [
  { name: "filler-1", type: "misc", seq: filler(120, 7) },
  { name: "M13 fwd", type: "primer_bind", seq: partSeq("M13 fwd") },
  { name: "MCS", type: "misc_feature", seq: PUC19_MCS },
  { name: "spacer-1", type: "misc", seq: filler(40, 11) },
  { name: "T7 promoter", type: "promoter", seq: partSeq("T7 promoter") },
  { name: "lac operator", type: "protein_bind", seq: partSeq("lac operator") },
  { name: "spacer-2", type: "misc", seq: "ACC" },
  { name: "strong RBS", type: "RBS", seq: partSeq("strong RBS") },
  { name: "spacer-3", type: "misc", seq: "TACAT" },
  { name: "GFP", type: "CDS", seq: "ATG" + partSeq("6xHis") + partSeq("TEV site") + GFP_CDS.slice(3) },
  { name: "spacer-4", type: "misc", seq: filler(25, 23) },
  { name: "T7 terminator", type: "terminator", seq: partSeq("T7 terminator") },
  { name: "filler-2", type: "misc", seq: filler(200, 29) },
  { name: "loxP", type: "protein_bind", seq: partSeq("loxP") },
  { name: "filler-3", type: "misc", seq: filler(150, 31) },
];

function build(): { sequence: string; features: { name: string; type: string; start: number; end: number; strand: 1 | -1 }[] } {
  let sequence = "";
  const features: { name: string; type: string; start: number; end: number; strand: 1 | -1 }[] = [];
  for (const seg of SEGMENTS) {
    const start = sequence.length;
    sequence += seg.seq;
    if (!seg.name.startsWith("filler") && !seg.name.startsWith("spacer")) {
      features.push({ name: seg.name, type: seg.type, start, end: sequence.length, strand: seg.strand ?? 1 });
    }
  }
  return { sequence, features };
}

const built = build();

/** ~1.6 kb circular test construct. */
export const DEMO_PLASMID = built.sequence;
export const DEMO_FEATURES = built.features;
export const DEMO_IS_CIRCULAR = true;

/** Coordinates of the GFP coding sequence within the demo plasmid. */
export const GFP_RANGE = (() => {
  const f = built.features.find((x) => x.name === "GFP")!;
  return { start: f.start, end: f.end };
})();

/** Sanity check used by tests: the CDS must translate back to the published protein. */
export function demoCdsTranslatesCorrectly(): boolean {
  const cds = DEMO_PLASMID.slice(GFP_RANGE.start, GFP_RANGE.end);
  const protein = translate(cds, { toStop: true });
  return protein.endsWith(GFP_PROTEIN.slice(1)) && protein.startsWith("MHHHHHHENLYFQG");
}
