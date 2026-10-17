import { describe, expect, it } from "vitest";
import { applyEdits, deleteRange, insertBases, replaceRange, reverseComplementSequence, setOrigin } from "./edit";
import type { BioFeature } from "./formats/types";
import { buildLane, formatSize, getLadder, migration, resolvingRange, suggestAgarose } from "./gel";
import { reverseComplement } from "./seq";

const feature = (name: string, segments: { start: number; end: number }[], strand: 1 | -1 = 1): BioFeature => ({
  name,
  type: "CDS",
  strand,
  segments,
  qualifiers: {},
});

describe("sequence editing", () => {
  //               0         1         2         3
  //               0123456789012345678901234567890123456789
  const sequence = "AAAAACCCCCGGGGGTTTTTACGTACGTACGTACGTACGT";
  const features = [
    feature("early", [{ start: 0, end: 5 }]),
    feature("middle", [{ start: 10, end: 20 }]),
    feature("late", [{ start: 30, end: 40 }]),
  ];

  it("inserts bases and moves downstream features", () => {
    const result = insertBases(sequence, features, 7, "TTT", false);
    expect(result.sequence).toBe("AAAAACC" + "TTT" + "CCCGGGGGTTTTTACGTACGTACGTACGTACGT");
    expect(result.features.find((f) => f.name === "early")!.segments).toEqual([{ start: 0, end: 5 }]);
    expect(result.features.find((f) => f.name === "middle")!.segments).toEqual([{ start: 13, end: 23 }]);
    expect(result.features.find((f) => f.name === "late")!.segments).toEqual([{ start: 33, end: 43 }]);
  });

  it("grows a feature when bases are inserted inside it", () => {
    const result = insertBases(sequence, features, 15, "GG", false);
    expect(result.features.find((f) => f.name === "middle")!.segments).toEqual([{ start: 10, end: 22 }]);
    expect(result.truncated.map((f) => f.name)).toContain("middle");
  });

  it("deletes a range and pulls later features back", () => {
    const result = deleteRange(sequence, features, { start: 5, end: 10 }, false);
    expect(result.sequence).toBe("AAAAA" + "GGGGGTTTTTACGTACGTACGTACGTACGT");
    expect(result.features.find((f) => f.name === "middle")!.segments).toEqual([{ start: 5, end: 15 }]);
  });

  it("trims a feature the edit partially removes", () => {
    const result = deleteRange(sequence, features, { start: 15, end: 25 }, false);
    expect(result.features.find((f) => f.name === "middle")!.segments).toEqual([{ start: 10, end: 15 }]);
    expect(result.truncated.map((f) => f.name)).toContain("middle");
  });

  it("drops a feature the edit removes entirely", () => {
    const result = deleteRange(sequence, features, { start: 8, end: 22 }, false);
    expect(result.features.map((f) => f.name)).toEqual(["early", "late"]);
    expect(result.removed.map((f) => f.name)).toEqual(["middle"]);
  });

  it("replaces a range, adjusting the feature to the new length", () => {
    const result = replaceRange(sequence, features, { start: 12, end: 18 }, "AC", false);
    expect(result.sequence).toHaveLength(sequence.length - 4);
    expect(result.features.find((f) => f.name === "middle")!.segments).toEqual([{ start: 10, end: 16 }]);
  });

  it("applies several edits at once without coordinates drifting", () => {
    const result = applyEdits(
      sequence,
      features,
      [
        { start: 5, end: 10, insert: "" },
        { start: 30, end: 30, insert: "GGGG" },
      ],
      false,
    );
    expect(result.sequence).toBe("AAAAA" + "GGGGGTTTTT" + "ACGTACGTAC" + "GGGG" + "GTACGTACGT");
    expect(result.sequence).toHaveLength(sequence.length - 5 + 4);
    expect(result.features.find((f) => f.name === "middle")!.segments).toEqual([{ start: 5, end: 15 }]);
    // Bases inserted exactly at a feature's start go before it, so "late" keeps its length.
    const late = result.features.find((f) => f.name === "late")!;
    expect(late.segments).toEqual([{ start: 29, end: 39 }]);
    expect(result.sequence.slice(29, 39)).toBe(sequence.slice(30, 40));
  });

  it("refuses overlapping edits rather than guessing", () => {
    expect(() =>
      applyEdits(sequence, features, [
        { start: 5, end: 15, insert: "" },
        { start: 10, end: 20, insert: "" },
      ], false),
    ).toThrow(/overlap/);
  });

  it("reverse complements a molecule and all its features", () => {
    const result = reverseComplementSequence(sequence, features);
    expect(result.sequence).toBe(reverseComplement(sequence));
    const early = result.features.find((f) => f.name === "early")!;
    expect(early.strand).toBe(-1);
    expect(early.segments).toEqual([{ start: 35, end: 40 }]);
    // The bases the feature covers are unchanged, just read on the other strand.
    expect(result.sequence.slice(35, 40)).toBe(reverseComplement(sequence.slice(0, 5)));
  });
});

describe("setting the origin of a plasmid", () => {
  const sequence = "AAAAACCCCCGGGGGTTTTT"; // 20 bp circle
  const features = [feature("spans", [{ start: 2, end: 8 }]), feature("late", [{ start: 15, end: 20 }])];

  it("rotates the sequence", () => {
    const result = setOrigin(sequence, features, 5);
    expect(result.sequence).toBe("CCCCCGGGGGTTTTTAAAAA");
  });

  it("moves features with the rotation", () => {
    const result = setOrigin(sequence, features, 5);
    expect(result.features.find((f) => f.name === "late")!.segments).toEqual([{ start: 10, end: 15 }]);
  });

  it("splits a feature that ends up crossing the new origin", () => {
    const result = setOrigin(sequence, features, 5);
    const spans = result.features.find((f) => f.name === "spans")!;
    // The feature covered 2..8; after rotating by 5 it runs 17..20 + 0..3.
    expect(spans.segments).toEqual([{ start: 17, end: 20 }, { start: 0, end: 3 }]);
    const bases = spans.segments.map((s) => result.sequence.slice(s.start, s.end)).join("");
    expect(bases).toBe(sequence.slice(2, 8));
  });

  it("is a no-op when the origin does not move", () => {
    expect(setOrigin(sequence, features, 0).sequence).toBe(sequence);
  });
});

describe("virtual gel", () => {
  it("runs larger fragments less far", () => {
    const conditions = { agarose: 1 };
    expect(migration(5000, conditions)).toBeLessThan(migration(1000, conditions));
    expect(migration(1000, conditions)).toBeLessThan(migration(500, conditions));
  });

  it("clamps fragments outside the resolving range", () => {
    const conditions = { agarose: 1 };
    expect(migration(500000, conditions)).toBeGreaterThanOrEqual(0.02);
    expect(migration(5, conditions)).toBeLessThanOrEqual(0.98);
  });

  it("knows what each agarose percentage resolves", () => {
    expect(resolvingRange(0.5).max).toBeGreaterThan(resolvingRange(2).max);
    expect(resolvingRange(2).min).toBeLessThan(resolvingRange(0.5).min);
    expect(suggestAgarose([5000, 3000])).toBeLessThan(suggestAgarose([150, 300]));
  });

  it("merges bands a gel could not separate", () => {
    const lane = buildLane("digest", [3000, 2950, 500], { agarose: 1 });
    expect(lane.bands).toHaveLength(2);
    expect(lane.bands[0]).toMatchObject({ count: 2, label: "3 kb (x2)" });
    expect(lane.bands[1]!.sizeBp).toBe(500);
  });

  it("flags fragments the gel cannot show", () => {
    const lane = buildLane("digest", [40000, 1000, 20], { agarose: 1 });
    expect(lane.unresolved.tooLarge).toEqual([40000]);
    expect(lane.unresolved.tooSmall).toEqual([20]);
  });

  it("stains bands in proportion to DNA mass", () => {
    const lane = buildLane("digest", [5000, 200], { agarose: 1 });
    const big = lane.bands.find((b) => b.sizeBp === 5000)!;
    const small = lane.bands.find((b) => b.sizeBp === 200)!;
    expect(big.intensity).toBeGreaterThan(small.intensity);
  });

  it("ships standard ladders", () => {
    expect(getLadder("1 kb DNA ladder")!.sizes).toContain(3000);
    expect(getLadder("100 bp DNA ladder")!.sizes[0]).toBe(1517);
    expect(formatSize(1500)).toBe("1.5 kb");
    expect(formatSize(500)).toBe("500 bp");
    expect(formatSize(10000)).toBe("10 kb");
  });
});
