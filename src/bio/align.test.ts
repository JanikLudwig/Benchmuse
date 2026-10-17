import { describe, expect, it } from "vitest";
import { alignPair, alignRead, cigarString, DNA_SCORING } from "./align";
import type { BioFeature } from "./formats/types";
import { reverseComplement, translate } from "./seq";
import { DEMO_PLASMID, GFP_RANGE } from "./testPlasmid";
import { callVariants, summarizeVariants } from "./variants";

describe("pairwise alignment", () => {
  it("aligns identical sequences end to end", () => {
    const a = alignPair("ACGTACGTAC", "ACGTACGTAC");
    expect(a.identity).toBe(1);
    expect(a.mismatches).toBe(0);
    expect(a.gaps).toBe(0);
    expect(cigarString(a.cigar)).toBe("10M");
  });

  it("reports a substitution as a mismatch, not a gap", () => {
    const a = alignPair("ACGTACGTAC", "ACGTTCGTAC");
    expect(cigarString(a.cigar)).toBe("10M");
    expect(a.mismatches).toBe(1);
    expect(a.matches).toBe(9);
  });

  it("prefers one gap over several mismatches", () => {
    const ref = "ACGTACGTACGTACGT";
    const query = "ACGTAGTACGTACGT"; // one base deleted
    const a = alignPair(ref, query);
    expect(cigarString(a.cigar)).toMatch(/D/);
    expect(a.gaps).toBe(1);
    expect(a.mismatches).toBe(0);
  });

  it("keeps a multi-base gap together with affine penalties", () => {
    const ref = "ACGTACGTAAAAAACGTACGTACGT";
    const query = "ACGTACGTACGTACGTACGT"; // six bases removed
    const a = alignPair(ref, query);
    const deletions = a.cigar.filter((r) => r.op === "D");
    expect(deletions).toHaveLength(1);
    expect(deletions[0]!.length).toBe(5);
  });

  it("finds a local region inside unrelated flanks", () => {
    const shared = "GGTCATGCAGTTACCGATCATTGCA";
    const a = alignPair(`TTTTTTTTTT${shared}AAAAAAAAAA`, `CCCCC${shared}GGGGG`, "local");
    expect(a.identity).toBe(1);
    expect(a.alignedRef).toBe(shared);
    expect(a.refStart).toBe(10);
    expect(a.refEnd).toBe(10 + shared.length);
  });

  it("aligns the whole query inside a longer reference in glocal mode", () => {
    const ref = "TTTTTTTTTTACGGTCATGCAGTTACCGATCAAAAAAAAAAA";
    const query = "ACGGTCATGCAGTTACCGATCA";
    const a = alignPair(ref, query, "glocal");
    expect(a.queryStart).toBe(0);
    expect(a.queryEnd).toBe(query.length);
    expect(a.refStart).toBe(10);
    expect(a.identity).toBe(1);
  });

  it("handles empty input without throwing", () => {
    expect(alignPair("", "ACGT").score).toBe(0);
    expect(alignPair("ACGT", "").cigar).toEqual([]);
  });

  it("scores degenerate bases as compatible rather than mismatched", () => {
    const strict = alignPair("ACGTACGT", "ACGAACGT", "global", DNA_SCORING);
    const degenerate = alignPair("ACGNACGT", "ACGAACGT", "global", DNA_SCORING);
    expect(degenerate.score).toBeGreaterThan(strict.score);
  });
});

describe("read alignment", () => {
  const reference = DEMO_PLASMID;

  it("places a perfect read and reports the strand", () => {
    const read = reference.slice(400, 1000);
    const a = alignRead(reference, read, true)!;
    expect(a.strand).toBe(1);
    expect(a.identity).toBe(1);
    expect(a.refStartOnReference).toBe(400);
    expect(a.refEndOnReference).toBe(1000);
  });

  it("places a reverse-complemented read", () => {
    const read = reverseComplement(reference.slice(400, 1000));
    const a = alignRead(reference, read, true)!;
    expect(a.strand).toBe(-1);
    expect(a.identity).toBe(1);
    expect(a.refStartOnReference).toBe(400);
    expect(a.orientedQuery).toBe(reference.slice(400, 1000));
  });

  it("aligns a read that crosses the origin of a plasmid", () => {
    const read = reference.slice(-300) + reference.slice(0, 300);
    const a = alignRead(reference, read, true)!;
    expect(a.identity).toBe(1);
    expect(a.spansOrigin).toBe(true);
    expect(a.refStartOnReference).toBe(reference.length - 300);
    expect(a.refEndOnReference).toBe(300);
  });

  it("returns null when the read is unrelated", () => {
    const junk = "GGGGGGGGGGCCCCCCCCCCGGGGGGGGGGCCCCCCCCCC".repeat(5);
    const a = alignRead(reference, junk, true);
    expect(a === null || a.identity < 0.75).toBe(true);
  });
});

describe("variant calling", () => {
  const reference = DEMO_PLASMID;
  const gfp: BioFeature = {
    name: "GFP",
    type: "CDS",
    strand: 1,
    segments: [{ start: GFP_RANGE.start, end: GFP_RANGE.end }],
    qualifiers: {},
  };

  /** Reference index of a given base within a given codon of the GFP CDS. */
  const codonBase = (codon: number, offset: number) => GFP_RANGE.start + codon * 3 + offset;

  const mutate = (source: string, index: number, base: string) => source.slice(0, index) + base + source.slice(index + 1);

  function callAgainst(read: string) {
    const alignment = alignRead(reference, read, true)!;
    return callVariants(reference, alignment, { features: [gfp], referenceLength: reference.length, isCircular: true });
  }

  it("finds a single substitution at the right position", () => {
    // Codon 9 of the CDS is CTG (Leu); changing its third base to A gives CTA, still Leu.
    const pos = codonBase(9, 2);
    expect(reference.slice(codonBase(9, 0), codonBase(9, 3))).toBe("CTG");
    const read = mutate(reference.slice(280, 900), pos - 280, "A");
    const variants = callAgainst(read);
    expect(variants).toHaveLength(1);
    expect(variants[0]).toMatchObject({ type: "substitution", refStart: pos, refBases: "G", queryBases: "A" });
    expect(variants[0]!.label).toBe(`g.${pos + 1}G>A`);
  });

  it("classifies synonymous, missense and nonsense changes", () => {
    const synonymous = callAgainst(mutate(reference.slice(280, 900), codonBase(9, 2) - 280, "A"));
    expect(synonymous[0]!.effects[0]).toMatchObject({
      featureName: "GFP",
      consequence: "synonymous",
      aaPosition: 10,
      codonChange: "CTG>CTA",
      proteinChange: "p.Leu10=",
    });

    // Codon 7 is GAA (Glu); GAA -> GCA is Ala.
    expect(reference.slice(codonBase(7, 0), codonBase(7, 3))).toBe("GAA");
    const missense = callAgainst(mutate(reference.slice(280, 900), codonBase(7, 1) - 280, "C"));
    expect(missense[0]!.effects[0]).toMatchObject({
      consequence: "missense",
      aaPosition: 8,
      codonChange: "GAA>GCA",
      proteinChange: "p.Glu8Ala",
    });

    // Codon 12 is CAG (Gln); CAG -> TAG is a stop.
    expect(reference.slice(codonBase(12, 0), codonBase(12, 3))).toBe("CAG");
    const nonsense = callAgainst(mutate(reference.slice(280, 900), codonBase(12, 0) - 280, "T"));
    expect(nonsense[0]!.effects[0]).toMatchObject({
      consequence: "nonsense",
      aaPosition: 13,
      proteinChange: "p.Gln13Ter",
    });
  });

  it("calls a frameshift for a single-base deletion and an in-frame change for three", () => {
    const start = codonBase(20, 0);
    const window = reference.slice(280, 900);
    const oneDeleted = window.slice(0, start - 280) + window.slice(start - 280 + 1);
    const fs = callAgainst(oneDeleted);
    expect(fs).toHaveLength(1);
    expect(fs[0]!.type).toBe("deletion");
    expect(fs[0]!.effects[0]!.consequence).toBe("frameshift");

    const threeDeleted = window.slice(0, start - 280) + window.slice(start - 280 + 3);
    const inFrame = callAgainst(threeDeleted);
    expect(inFrame[0]!.effects[0]!.consequence).toBe("in-frame deletion");
    expect(inFrame[0]!.refBases).toHaveLength(3);
  });

  it("calls an insertion and labels it between the flanking bases", () => {
    const at = 500;
    const window = reference.slice(280, 900);
    const inserted = window.slice(0, at - 280) + "GGG" + window.slice(at - 280);
    const variants = callAgainst(inserted);
    expect(variants).toHaveLength(1);
    expect(variants[0]).toMatchObject({ type: "insertion", queryBases: "GGG" });
    expect(variants[0]!.label).toMatch(/^g\.\d+_\d+insGGG$/);
  });

  it("left-aligns an indel inside a homopolymer", () => {
    // Build a reference with a clean run so the shift is unambiguous.
    const ref = "ACGTACGTACGT" + "AAAAAA" + "TTGCATGCATTGCAGTCA";
    const read = "ACGTACGTACGT" + "AAAAA" + "TTGCATGCATTGCAGTCA"; // one A missing
    const alignment = alignRead(ref, read, false, { exhaustive: true })!;
    const variants = callVariants(ref, alignment, { referenceLength: ref.length });
    expect(variants).toHaveLength(1);
    // Whichever A the aligner removed, the variant is reported at the first one.
    expect(variants[0]).toMatchObject({ type: "deletion", refStart: 12, refBases: "A" });
    expect(variants[0]!.label).toBe("g.13del");
  });

  it("complements the substituted base for a CDS on the minus strand", () => {
    const minusCds: BioFeature = {
      name: "revGene",
      type: "CDS",
      strand: -1,
      // Choose a frame so that the mutated base lands in a known codon.
      segments: [{ start: 400, end: 499 }],
      qualifiers: {},
    };
    const pos = 490;
    const read = mutate(reference.slice(380, 520), pos - 380, reference[pos] === "A" ? "G" : "A");
    const alignment = alignRead(reference, read, true)!;
    const variants = callVariants(reference, alignment, { features: [minusCds], referenceLength: reference.length, isCircular: true });
    const effect = variants[0]!.effects[0]!;
    expect(effect.featureName).toBe("revGene");
    // The reported codon must come from the reverse-complement reading of the feature.
    const cds = reverseComplement(reference.slice(400, 499));
    const codonIndex = effect.aaPosition! - 1;
    expect(effect.codonChange!.split(">")[0]).toBe(cds.slice(codonIndex * 3, codonIndex * 3 + 3).toUpperCase());
  });

  it("reports variants outside any CDS as non-coding", () => {
    const pos = 150; // inside the polylinker, before the CDS
    const read = mutate(reference.slice(60, 260), pos - 60, reference[pos] === "A" ? "G" : "A");
    const variants = callAgainst(read);
    expect(variants[0]!.effects[0]).toMatchObject({ consequence: "non-coding" });
  });

  it("filters low-quality base calls", () => {
    const pos = 500;
    const window = reference.slice(280, 900);
    const read = mutate(window, pos - 280, reference[pos] === "A" ? "G" : "A");
    const alignment = alignRead(reference, read, true)!;
    const qualities = new Array(read.length).fill(40);
    qualities[pos - 280] = 8; // a poor call at the variant position
    const strict = callVariants(reference, alignment, { qualities, minQuality: 20, referenceLength: reference.length, isCircular: true });
    const lenient = callVariants(reference, alignment, { qualities, referenceLength: reference.length, isCircular: true });
    expect(strict).toEqual([]);
    expect(lenient).toHaveLength(1);
    expect(lenient[0]!.quality).toBe(8);
  });

  it("finds several variants in one read and summarises them", () => {
    let window = reference.slice(280, 900);
    window = mutate(window, codonBase(9, 2) - 280, "A"); // synonymous
    window = mutate(window, codonBase(12, 0) - 280, "T"); // nonsense
    const variants = callAgainst(window);
    expect(variants).toHaveLength(2);
    expect(summarizeVariants(variants)).toEqual({ synonymous: 1, nonsense: 1 });
  });

  it("reports a clean read as having no variants", () => {
    expect(callAgainst(reference.slice(280, 900))).toEqual([]);
  });

  it("checks the demo CDS really encodes the expected protein", () => {
    const protein = translate(reference.slice(GFP_RANGE.start, GFP_RANGE.end), { toStop: true });
    expect(protein.startsWith("MHHHHHHENLYFQG")).toBe(true);
  });
});
