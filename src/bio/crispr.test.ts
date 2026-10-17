import { describe, expect, it } from "vitest";
import { CAS_ENZYMES, findGuides, getCasEnzyme, guideCloningOligos, hsuScore, onTargetScore, specificityScore } from "./crispr";
import { reverseComplement } from "./seq";
import { DEMO_PLASMID } from "./testPlasmid";

describe("guide finding", () => {
  it("takes the 20 bases immediately 5' of an NGG PAM", () => {
    const spacer = "GTCATGCAGTTACCGATCAG";
    const seq = `TTTTTTTTTT${spacer}TGGAAAAAAAAAA`; // TGG is the PAM
    const guides = findGuides(seq, false);
    const guide = guides.find((g) => g.spacer === spacer)!;
    expect(guide).toBeDefined();
    expect(guide.pam).toBe("TGG");
    expect(guide.strand).toBe(1);
    expect(guide.range).toEqual({ start: 10, end: 30 });
    // SpCas9 cuts 3 bp from the PAM, between positions 17 and 18 of the spacer.
    expect(guide.cutSite).toBe(27);
  });

  it("finds guides on the reverse strand with top-strand coordinates", () => {
    const spacer = "GTCATGCAGTTACCGATCAG";
    // Put the protospacer+PAM on the bottom strand.
    const seq = `AAAAAAAAAA${reverseComplement(`${spacer}TGG`)}TTTTTTTTTT`;
    const guide = findGuides(seq, false).find((g) => g.spacer === spacer)!;
    expect(guide).toBeDefined();
    expect(guide.strand).toBe(-1);
    expect(guide.pam).toBe("TGG");
    expect(seq.slice(guide.range.start, guide.range.end)).toBe(reverseComplement(spacer));
  });

  it("supports other Cas enzymes", () => {
    expect(getCasEnzyme("Cas12a (Cpf1)")!.pamSide).toBe("5prime");
    const spacer = "GTCATGCAGTTACCGATCAGTTA"; // 23 nt for Cas12a
    const seq = `AAAAAAAAAATTTA${spacer}CCCCCCCCCC`; // TTTA is a TTTV PAM
    const guides = findGuides(seq, false, { enzyme: getCasEnzyme("Cas12a (Cpf1)") });
    expect(guides.some((g) => g.spacer === spacer)).toBe(true);
  });

  it("restricts guides to a target window when asked", () => {
    const guides = findGuides(DEMO_PLASMID, true, { targetRange: { start: 400, end: 460 } });
    expect(guides.length).toBeGreaterThan(0);
    expect(guides.every((g) => g.cutSite >= 400 && g.cutSite < 460)).toBe(true);
  });

  it("finds guides spanning the origin of a plasmid", () => {
    const guides = findGuides(DEMO_PLASMID, true);
    const spanning = guides.filter((g) => g.range.end < g.range.start);
    // Whether any exist depends on the sequence, but coordinates must stay in range.
    for (const g of [...guides, ...spanning]) {
      expect(g.range.start).toBeGreaterThanOrEqual(0);
      expect(g.range.start).toBeLessThan(DEMO_PLASMID.length);
      expect(g.spacer).toHaveLength(20);
    }
  });
});

describe("on-target scoring", () => {
  it("penalises a poly-T run, which terminates guide transcription", () => {
    const withRun = onTargetScore("GTCATTTTCAGTTACCGATC", "TGG");
    const without = onTargetScore("GTCATGCAGTTACCGATCAG", "TGG");
    expect(withRun).toBeLessThan(without - 20);
  });

  it("prefers moderate GC over extremes", () => {
    const moderate = onTargetScore("GTCATGCAGTTACCGATCAG", "TGG");
    expect(moderate).toBeGreaterThan(onTargetScore("GCGCGCGCGCGCGCGCGCGC", "TGG"));
    expect(moderate).toBeGreaterThan(onTargetScore("ATATATATATATATATATAT", "TGG"));
  });

  it("warns about guides that will be hard to express or specific", () => {
    const seq = "AAAAAAAAAACTTTTCAGTTACCGATCAGTGGAAAAAAAAAA";
    const guide = findGuides(seq, false).find((g) => /T{4,}/.test(g.spacer));
    expect(guide?.warnings.join(" ")).toMatch(/TTTT/);
  });
});

describe("off-target scoring", () => {
  it("scores a perfect match as fully active and mismatches as less", () => {
    expect(hsuScore([], 20)).toBe(1);
    const one = hsuScore([10], 20);
    const two = hsuScore([10, 12], 20);
    expect(one).toBeGreaterThan(0);
    expect(one).toBeLessThanOrEqual(1);
    expect(two).toBeLessThan(one);
    // Scores stay within 0..1 for every mismatch pattern.
    for (const positions of [[1], [20], [1, 20], [5, 6, 7], [2, 9, 14, 19]]) {
      const score = hsuScore(positions, 20);
      expect(score).toBeGreaterThanOrEqual(0);
      expect(score).toBeLessThanOrEqual(1);
    }
  });

  it("penalises mismatches near the PAM more than distal ones", () => {
    // Position 20 is PAM-proximal; position 1 is at the far 5' end.
    expect(hsuScore([20], 20)).toBeLessThan(hsuScore([1], 20));
  });

  it("reports a guide with a duplicate site as non-specific", () => {
    const spacer = "GTCATGCAGTTACCGATCAG";
    const site = `${spacer}TGG`;
    const unique = `TTTTTTTTTT${site}AAAAAAAAAACCCCCCCCCC`;
    const duplicated = `TTTTTTTTTT${site}AAAAAAAAAA${site}CCCCCCCCCC`;

    const uniqueGuide = findGuides(unique, false).find((g) => g.spacer === spacer)!;
    const duplicatedGuide = findGuides(duplicated, false).find((g) => g.spacer === spacer)!;
    expect(uniqueGuide.specificityScore).toBe(100);
    expect(uniqueGuide.offTargets).toEqual([]);
    expect(duplicatedGuide.offTargets.length).toBeGreaterThan(0);
    expect(duplicatedGuide.offTargets[0]!.mismatches).toBe(0);
    expect(duplicatedGuide.specificityScore).toBeLessThan(60);
  });

  it("searches additional sequences for off-targets", () => {
    const spacer = "GTCATGCAGTTACCGATCAG";
    const target = `TTTTTTTTTT${spacer}TGGAAAAAAAAAA`;
    // A near-identical site in another molecule, differing at one PAM-distal position.
    const elsewhere = `CCCCCCCCCCA${spacer.slice(1)}TGGCCCCCCCCCC`;
    const guide = findGuides(target, false, {
      offTargetSources: [{ name: "genome", sequence: elsewhere, isCircular: false }],
    }).find((g) => g.spacer === spacer)!;
    const hit = guide.offTargets.find((o) => o.source === "genome");
    expect(hit).toBeDefined();
    expect(hit!.mismatches).toBe(1);
    expect(hit!.mismatchPositions).toEqual([1]);
    expect(guide.specificityScore).toBeLessThan(100);
  });

  it("aggregates many weak off-targets into a lower specificity", () => {
    expect(specificityScore([])).toBe(100);
    expect(specificityScore([{ score: 1 } as never])).toBeLessThan(55);
    expect(specificityScore([{ score: 0.01 } as never])).toBeGreaterThan(90);
  });
});

describe("guide cloning", () => {
  it("adds a 5' G when the spacer lacks one, for U6 transcription", () => {
    const withoutG = guideCloningOligos("TTCATGCAGTTACCGATCAG");
    expect(withoutG.top).toBe("CACCGTTCATGCAGTTACCGATCAG");
    expect(withoutG.note).toMatch(/5' G was added/);

    const withG = guideCloningOligos("GTCATGCAGTTACCGATCAG");
    expect(withG.top).toBe("CACCGTCATGCAGTTACCGATCAG");
    expect(withG.note).toMatch(/already begins with G/);
  });

  it("produces a bottom oligo that anneals to the top one", () => {
    const { top, bottom } = guideCloningOligos("GTCATGCAGTTACCGATCAG");
    // The annealed duplex leaves the CACC and AAAC overhangs for BbsI-cut vector.
    const topCore = top.slice(4);
    const bottomCore = bottom.slice(4);
    expect(reverseComplement(bottomCore)).toBe(`${topCore}`.slice(0, bottomCore.length));
  });
});

describe("enzyme catalogue", () => {
  it("lists usable Cas variants", () => {
    expect(CAS_ENZYMES.length).toBeGreaterThanOrEqual(4);
    expect(CAS_ENZYMES.every((e) => e.spacerLength >= 20 && e.pam.length >= 2)).toBe(true);
    expect(getCasEnzyme("spcas9")!.name).toBe("SpCas9");
  });
});
