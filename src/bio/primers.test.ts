import { describe, expect, it } from "vitest";
import { suggestAnnotations } from "./features/annotate";
import { getPart } from "./features/library";
import {
  crossDimer,
  designPrimers,
  findBindingSites,
  primerStats,
  recommendedAnnealingTemp,
  simulatePcr,
} from "./primers";
import { reverseComplement, translate } from "./seq";
import { DEMO_PLASMID, demoCdsTranslatesCorrectly, GFP_PROTEIN, GFP_RANGE } from "./testPlasmid";
import {
  DEFAULT_CONDITIONS,
  effectiveSalt,
  hairpin,
  longestHomopolymer,
  meltingTemp,
  PCR_CONDITIONS,
  selfDimer,
  wallaceTm,
} from "./thermo";

describe("melting temperature", () => {
  it("reproduces published values for standard primers", () => {
    // M13 forward at 0.25 µM / 50 mM Na+ is ~52 °C in IDT's OligoAnalyzer.
    expect(meltingTemp("GTAAAACGACGGCCAGT")).toBeCloseTo(51.7, 0);
    // A 20-mer at 50% GC lands in the usual 55-60 °C design window.
    expect(meltingTemp("ATGCATGCATGCATGCATGC")).toBeGreaterThan(55);
    expect(meltingTemp("ATGCATGCATGCATGCATGC")).toBeLessThan(60);
  });

  it("orders sequences by stability", () => {
    const gc = meltingTemp("GCGCGCGCGCGCGCGCGCGC");
    const mixed = meltingTemp("ATGCATGCATGCATGCATGC");
    const at = meltingTemp("ATATATATATATATATATAT");
    expect(gc).toBeGreaterThan(mixed);
    expect(mixed).toBeGreaterThan(at);
    expect(meltingTemp("ATGCATGCATGCATGCATGCATGCATGCAT")).toBeGreaterThan(mixed); // longer is hotter
  });

  it("is symmetric under reverse complement", () => {
    const seq = "TTGGAATTCCAAGGTACCTT";
    expect(meltingTemp(seq)).toBeCloseTo(meltingTemp(reverseComplement(seq)), 6);
  });

  it("rises with salt, and converts magnesium to a monovalent equivalent", () => {
    const seq = "ATGCATGCATGCATGCATGC";
    expect(meltingTemp(seq, { sodium: 0.1 })).toBeGreaterThan(meltingTemp(seq, { sodium: 0.02 }));
    // 50 mM Na+ with 2 mM Mg2+ and 0.2 mM dNTP behaves like ~210 mM monovalent.
    expect(effectiveSalt(PCR_CONDITIONS) * 1000).toBeCloseTo(211, 0);
    expect(meltingTemp(seq, PCR_CONDITIONS)).toBeGreaterThan(meltingTemp(seq, DEFAULT_CONDITIONS));
  });

  it("falls back to the GC rule for degenerate oligos", () => {
    expect(meltingTemp("ATGCRYATGCATGC")).toBe(wallaceTm("ATGCRYATGCATGC"));
    expect(meltingTemp("A")).toBe(0);
  });

  it("flags self-structure", () => {
    expect(selfDimer("GGGGCCCC").pairedLength).toBe(8);
    expect(selfDimer("GGGGCCCC").dg).toBeLessThan(-8);
    expect(selfDimer("ATATATATAT").dg).toBeGreaterThan(selfDimer("GGGGCCCC").dg);
    expect(hairpin("GGGGCGCAAAAGCGCCCC").pairedLength).toBeGreaterThanOrEqual(4);
    expect(hairpin("ATATATATATATATAT").dg).toBe(0);
    expect(longestHomopolymer("ATTTTTGC")).toEqual({ base: "T", length: 5 });
  });
});

describe("primer evaluation", () => {
  it("accepts a good primer and explains a bad one", () => {
    const good = primerStats("GCTAGCATGACCATGATTACGG");
    expect(good.warnings).toEqual([]);
    expect(good.tm).toBeGreaterThan(55);
    expect(good.gcClamp).toBeGreaterThan(0);

    const bad = primerStats("AAAAAAAAAAAAAAAAAAAA");
    expect(bad.warnings.join(" ")).toMatch(/GC 0% is low/);
    expect(bad.warnings.join(" ")).toMatch(/Run of 20 As/);
  });

  it("detects primer dimers between a pair", () => {
    const dimer = crossDimer("GGGGGGGGCCATGATTACG", "CCCCCCCCGTAATCATGG");
    expect(dimer.dg).toBeLessThan(-8);
    expect(crossDimer("ATATATATAT", "GGGGGGGGGG").dg).toBeGreaterThan(-3);
  });

  it("recommends an annealing temperature from the cooler primer", () => {
    expect(recommendedAnnealingTemp(60, 64)).toBe(61);
    expect(recommendedAnnealingTemp(80, 82)).toBe(72); // capped
  });
});

describe("primer binding", () => {
  const template = DEMO_PLASMID;

  it("finds a perfectly matching primer on each strand", () => {
    const m13 = getPart("M13 fwd")!.sequence;
    const fwd = findBindingSites(template, m13, true);
    expect(fwd).toHaveLength(1);
    expect(fwd[0]).toMatchObject({ strand: 1, mismatches: 0, tail: "", annealedLength: m13.length });

    const rev = findBindingSites(template, reverseComplement(m13), true);
    expect(rev[0]).toMatchObject({ strand: -1, mismatches: 0, annealedLength: m13.length });
  });

  // Tail mechanics are checked on a synthetic template, so every flanking base is known.
  //                    0    5         15        25        35
  const synthetic = "CCCC" + "TTTT" + "ACGGTCATGCAGTTACCGATCA" + "GGGG";
  const annealRegion = synthetic.slice(8, 30);

  it("treats unmatched 5' bases as a tail", () => {
    const sites = findBindingSites(synthetic, `GAATTC${annealRegion}`, false, { maxMismatches: 0 });
    expect(sites).toHaveLength(1);
    expect(sites[0]).toMatchObject({ annealedLength: 22, tail: "GAATTC", strand: 1, mismatches: 0 });
    expect(sites[0]!.range).toEqual({ start: 8, end: 30 });
    expect(sites[0]!.extendFrom).toBe(30);
  });

  it("keeps annealing through tail bases that happen to match the template", () => {
    // The four Ts pair with the template's own TTTT, so they are not a tail at all.
    const sites = findBindingSites(synthetic, `TTTT${annealRegion}`, false, { maxMismatches: 0 });
    expect(sites[0]).toMatchObject({ annealedLength: 26, tail: "" });
    expect(sites[0]!.range).toEqual({ start: 4, end: 30 });
  });

  it("never ends the annealed region on a mismatched base", () => {
    // One mismatch two bases into the tail: annealing stops at the last base that pairs.
    const primer = `GGG${synthetic.slice(6, 8).replace(/T/g, "G")}${annealRegion}`;
    const site = findBindingSites(synthetic, primer, false)[0]!;
    expect(site.annealedLength).toBe(22);
    expect(site.mismatches).toBe(0);
    expect(site.tail).toBe("GGGGG");
  });

  it("tolerates an internal mismatch, as in a mutagenesis primer", () => {
    // The mutation sits 5' of the 3' anchor, which is where mutagenesis primers put it.
    const mutated = annealRegion.slice(0, 5) + (annealRegion[5] === "A" ? "C" : "A") + annealRegion.slice(6);
    const site = findBindingSites(synthetic, mutated, false)[0]!;
    expect(site).toMatchObject({ annealedLength: 22, mismatches: 1, tail: "" });
  });

  it("does not prime when the mismatch falls inside the 3' anchor", () => {
    // A primer mismatched within ~12 nt of its 3' end does not prime efficiently in the lab
    // either, so reporting no site is the honest answer.
    const nearThreePrime = annealRegion.slice(0, 15) + (annealRegion[15] === "A" ? "C" : "A") + annealRegion.slice(16);
    expect(findBindingSites(synthetic, nearThreePrime, false)).toEqual([]);
  });

  it("refuses to prime when the 3' end is mismatched", () => {
    const anneal = template.slice(300, 322);
    const mismatched3 = anneal.slice(0, -1) + (anneal.endsWith("A") ? "C" : "A");
    expect(findBindingSites(template, mismatched3, true)).toEqual([]);
    // ...but tolerates an internal mismatch.
    const internal = anneal.slice(0, 5) + (anneal[5] === "A" ? "C" : "A") + anneal.slice(6);
    expect(findBindingSites(template, internal, true)[0]?.mismatches).toBe(1);
  });

  it("finds sites spanning the origin of a plasmid", () => {
    const acrossOrigin = template.slice(-12) + template.slice(0, 10);
    const sites = findBindingSites(template, acrossOrigin, true, { minAnchor: 10 });
    expect(sites.some((s) => s.range.start === template.length - 12)).toBe(true);
  });
});

describe("PCR simulation", () => {
  it("amplifies the expected product and reports an annealing temperature", () => {
    const fwd = DEMO_PLASMID.slice(GFP_RANGE.start, GFP_RANGE.start + 22);
    const rev = reverseComplement(DEMO_PLASMID.slice(GFP_RANGE.end - 22, GFP_RANGE.end));
    const { products, warnings } = simulatePcr(DEMO_PLASMID, fwd, rev, true);
    expect(products).toHaveLength(1);
    expect(warnings).toEqual([]);
    const product = products[0]!;
    expect(product.length).toBe(GFP_RANGE.end - GFP_RANGE.start);
    expect(product.sequence).toBe(DEMO_PLASMID.slice(GFP_RANGE.start, GFP_RANGE.end));
    expect(translate(product.sequence, { toStop: true })).toContain(GFP_PROTEIN.slice(1, 40));
    expect(product.annealingTemp).toBeGreaterThan(45);
  });

  it("carries 5' tails into the product", () => {
    const fwd = "AAAGAATTC" + DEMO_PLASMID.slice(GFP_RANGE.start, GFP_RANGE.start + 22);
    const rev = "AAAAAGCTT" + reverseComplement(DEMO_PLASMID.slice(GFP_RANGE.end - 22, GFP_RANGE.end));
    const { products } = simulatePcr(DEMO_PLASMID, fwd, rev, true);
    const product = products[0]!;
    expect(product.sequence.startsWith("AAAGAATTC")).toBe(true);
    expect(product.sequence.endsWith("AAGCTTTTT")).toBe(true); // revcomp of the reverse tail
    expect(product.length).toBe(GFP_RANGE.end - GFP_RANGE.start + 18);
  });

  it("amplifies across the origin of a circular template", () => {
    const fwd = DEMO_PLASMID.slice(-40, -18);
    const rev = reverseComplement(DEMO_PLASMID.slice(30, 52));
    const { products } = simulatePcr(DEMO_PLASMID, fwd, rev, true);
    expect(products).toHaveLength(1);
    expect(products[0]!.length).toBe(40 + 52);
    // The same primers give nothing on a linear template.
    expect(simulatePcr(DEMO_PLASMID, fwd, rev, false).products).toEqual([]);
  });

  it("reports every product when a primer has more than one site", () => {
    // Duplicate the polylinker upstream, so the forward primer primes at two places.
    const mcs = DEMO_PLASMID.slice(137, 194);
    const repeated = mcs + DEMO_PLASMID;
    const fwd = DEMO_PLASMID.slice(137, 159);
    const rev = reverseComplement(DEMO_PLASMID.slice(400, 422));
    const { products, warnings, forwardSites } = simulatePcr(repeated, fwd, rev, false);
    expect(forwardSites.map((s) => s.range.start)).toEqual([0, 194]);
    expect(products).toHaveLength(2);
    expect(warnings.join(" ")).toMatch(/not specific/);
    // The shorter product is listed first, as on a gel.
    expect(products[0]!.length).toBeLessThan(products[1]!.length);
  });

  it("explains why nothing amplified", () => {
    const { products, warnings } = simulatePcr(DEMO_PLASMID, "ACGTACGTACGTACGTACGT", "TGCATGCATGCATGCATGCA", false);
    expect(products).toEqual([]);
    expect(warnings.join(" ")).toMatch(/does not anneal/);
  });
});

describe("primer design", () => {
  it("designs a usable pair that amplifies the requested region", () => {
    expect(demoCdsTranslatesCorrectly()).toBe(true);
    const pairs = designPrimers(DEMO_PLASMID, GFP_RANGE, true, { targetTm: 60 });
    expect(pairs.length).toBeGreaterThan(0);
    const best = pairs[0]!;
    expect(best.tmDifference).toBeLessThanOrEqual(4);
    expect(best.forward.warnings).toEqual([]);
    expect(best.reverse.warnings).toEqual([]);
    expect(best.forward.tm).toBeGreaterThan(55);
    expect(best.forward.tm).toBeLessThan(65);

    // The designed pair must actually amplify the target in simulation.
    const { products } = simulatePcr(DEMO_PLASMID, best.forward.oligo, best.reverse.oligo, true);
    expect(products).toHaveLength(1);
    expect(products[0]!.length).toBe(best.productLength);
    const covered = products[0]!.sequence;
    expect(covered).toContain(DEMO_PLASMID.slice(GFP_RANGE.start, GFP_RANGE.start + 50));
  });

  it("adds cloning tails to the ordered oligos", () => {
    const pairs = designPrimers(DEMO_PLASMID, GFP_RANGE, true, { forwardTail: "aaaGAATTC", reverseTail: "aaaAAGCTT" });
    const best = pairs[0]!;
    expect(best.forward.oligo.startsWith("aaaGAATTC")).toBe(true);
    expect(best.reverse.oligo.startsWith("aaaAAGCTT")).toBe(true);
    // Tails are excluded from the annealing Tm but included in the product length.
    expect(best.forward.tm).toBe(primerStats(best.forward.sequence).tm);
    expect(best.productLength).toBeGreaterThan(GFP_RANGE.end - GFP_RANGE.start);
  });

  it("returns nothing when the constraints cannot be met", () => {
    expect(designPrimers(DEMO_PLASMID, GFP_RANGE, true, { targetTm: 95, tmTolerance: 1 })).toEqual([]);
  });
});

describe("auto-annotation", () => {
  it("finds the library parts that were built into the demo plasmid", () => {
    const found = suggestAnnotations(DEMO_PLASMID, true);
    const names = found.map((f) => f.name);
    for (const expected of ["M13 fwd", "T7 promoter", "lac operator", "strong RBS", "6xHis", "TEV site", "T7 terminator", "loxP"]) {
      expect(names).toContain(expected);
    }
    const t7 = found.find((f) => f.name === "T7 promoter")!;
    expect(t7).toMatchObject({ type: "promoter", strand: 1, segments: [{ start: 234, end: 252 }] });
  });

  it("finds parts on the reverse strand", () => {
    const flipped = reverseComplement(DEMO_PLASMID);
    const t7 = suggestAnnotations(flipped, true).find((f) => f.name === "T7 promoter")!;
    expect(t7.strand).toBe(-1);
  });

  it("proposes ORFs and keeps the longest", () => {
    const found = suggestAnnotations(DEMO_PLASMID, true, { minOrfAa: 100 });
    const orfs = found.filter((f) => f.source === "orf");
    expect(orfs.length).toBeGreaterThan(0);
    const gfpOrf = orfs.find((o) => o.segments[0]!.start === GFP_RANGE.start);
    expect(gfpOrf).toBeDefined();
    expect(gfpOrf!.qualifiers.translation![0]).toContain(GFP_PROTEIN.slice(10, 40));
  });

  it("does not re-suggest features that already exist", () => {
    const existing = [{ segments: [{ start: 234, end: 252 }] }];
    const names = suggestAnnotations(DEMO_PLASMID, true, { existing }).map((f) => f.name);
    expect(names).not.toContain("T7 promoter");
    expect(names).toContain("lac operator");
  });
});
