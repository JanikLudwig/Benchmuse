import { describe, expect, it } from "vitest";
import { complementCode, couldMatch, guessKind, matchesPattern } from "./alphabet";
import { withDefaults } from "./options";
import { clampRange, rangeLength, rangesOverlap, segments, shiftRange, toDisplay } from "./range";
import { findMatches, findOrfs, gcContent, GENETIC_CODES, overlapLength, reverseComplement, sliceRange, translate } from "./seq";

describe("alphabet", () => {
  it("matches degenerate codes in the right direction", () => {
    expect(matchesPattern("A", "N")).toBe(true);
    expect(matchesPattern("A", "R")).toBe(true); // R = A or G
    expect(matchesPattern("C", "R")).toBe(false);
    expect(matchesPattern("N", "A")).toBe(false); // an ambiguous subject is not a definite A
    expect(couldMatch("N", "A")).toBe(true); // ...but it could be one
    expect(couldMatch("R", "Y")).toBe(false); // {A,G} and {C,T} are disjoint
  });

  it("complements degenerate codes and preserves case", () => {
    expect(complementCode("R")).toBe("Y");
    expect(complementCode("b")).toBe("v");
    expect(complementCode("N")).toBe("N");
    expect(complementCode("-")).toBe("-");
  });

  it("guesses sequence kind", () => {
    expect(guessKind("ATGCATGCATGCATGC")).toBe("dna");
    expect(guessKind("MSKGEELFTGVVPILVELDGDVNGHKF")).toBe("aa");
    expect(guessKind("atg cat\ngca")).toBe("dna");
  });
});

describe("ranges", () => {
  it("measures and splits wrapping ranges", () => {
    expect(rangeLength({ start: 2, end: 7 }, 10, false)).toBe(5);
    expect(rangeLength({ start: 8, end: 3 }, 10, true)).toBe(5);
    expect(rangeLength({ start: 0, end: 0 }, 10, true)).toBe(10); // whole circle
    expect(segments({ start: 8, end: 3 }, 10, true)).toEqual([
      { start: 8, end: 10 },
      { start: 0, end: 3 },
    ]);
    expect(segments({ start: 8, end: 3 }, 10, false)).toEqual([]); // invalid on linear
  });

  it("converts to 1-based inclusive display coordinates", () => {
    expect(toDisplay({ start: 0, end: 5 }, 10, false)).toEqual({ first: 1, last: 5 });
    expect(toDisplay({ start: 8, end: 3 }, 10, true)).toEqual({ first: 9, last: 3 });
  });

  it("detects overlap across the origin", () => {
    expect(rangesOverlap({ start: 8, end: 2 }, { start: 1, end: 5 }, 10, true)).toBe(true);
    expect(rangesOverlap({ start: 8, end: 2 }, { start: 3, end: 7 }, 10, true)).toBe(false);
  });

  it("clamps out-of-bounds ranges", () => {
    expect(clampRange({ start: -5, end: 4 }, 10)).toEqual({ start: 0, end: 4 });
    expect(clampRange({ start: 12, end: 20 }, 10)).toBeNull();
  });

  describe("shiftRange", () => {
    const L = 30;
    const feature = { start: 10, end: 20 };

    it("moves a feature after an insertion", () => {
      expect(shiftRange(feature, { start: 5, end: 5, insertedLength: 3 }, L, false)).toEqual({ start: 13, end: 23 });
    });

    it("leaves a feature before the edit alone", () => {
      expect(shiftRange(feature, { start: 25, end: 27, insertedLength: 0 }, L, false)).toEqual(feature);
    });

    it("grows and shrinks a feature edited inside it", () => {
      expect(shiftRange(feature, { start: 12, end: 15, insertedLength: 0 }, L, false)).toEqual({ start: 10, end: 17 });
      expect(shiftRange(feature, { start: 12, end: 12, insertedLength: 6 }, L, false)).toEqual({ start: 10, end: 26 });
    });

    it("truncates a feature the edit partially removed", () => {
      expect(shiftRange(feature, { start: 5, end: 15, insertedLength: 0 }, L, false)).toEqual({ start: 5, end: 10 });
      expect(shiftRange(feature, { start: 15, end: 25, insertedLength: 0 }, L, false)).toEqual({ start: 10, end: 15 });
    });

    it("drops a feature the edit removed entirely", () => {
      expect(shiftRange(feature, { start: 5, end: 25, insertedLength: 0 }, L, false)).toBeNull();
    });
  });
});

describe("sequence basics", () => {
  it("reverse complements, preserving case", () => {
    expect(reverseComplement("ATGC")).toBe("GCAT");
    expect(reverseComplement("ATgc")).toBe("gcAT");
    expect(reverseComplement("AAGCTT")).toBe("AAGCTT"); // HindIII is palindromic
  });

  it("computes GC content over counted bases only", () => {
    expect(gcContent("GGCC")).toBe(1);
    expect(gcContent("ATGC")).toBe(0.5);
    expect(gcContent("ATGCNN")).toBe(0.5); // Ns are not counted either way
    expect(gcContent("")).toBe(0);
  });

  it("slices across the origin", () => {
    expect(sliceRange("ABCDEFGHIJ", { start: 8, end: 3 }, true)).toBe("IJABC");
    expect(sliceRange("ABCDEFGHIJ", { start: 2, end: 5 }, false)).toBe("CDE");
  });

  it("finds the longest terminal overlap", () => {
    expect(overlapLength("AAATTTGGG", "GGGCCCAAA", 3, 20)).toBe(3);
    expect(overlapLength("AAATTT", "CCCGGG", 3, 20)).toBe(0);
  });
});

describe("translation", () => {
  it("translates the standard code", () => {
    expect(translate("ATGAAAGGGTAA")).toBe("MKG*");
    expect(translate("ATGAAAGGGTAA", { toStop: true })).toBe("MKG");
    expect(translate("ATG")).toBe("M");
    expect(translate("AT")).toBe(""); // incomplete codon
  });

  it("renders alternative start codons as methionine when asked", () => {
    expect(translate("CTGAAA")).toBe("LK");
    expect(translate("CTGAAA", { initiatorMet: true })).toBe("MK"); // CTG is a start in code 1
    // GTG is a start in the bacterial table but not in the standard one.
    expect(translate("GTGAAA", { initiatorMet: true })).toBe("VK");
    expect(translate("GTGAAA", { initiatorMet: true, code: GENETIC_CODES[11] })).toBe("MK");
  });

  it("marks unknown codons as X", () => {
    expect(translate("ATGNNNAAA")).toBe("MXK");
  });
});

describe("ORF finding", () => {
  it("finds a simple forward ORF", () => {
    const orfs = findOrfs("CCATGAAAGGGTAACC", false, { minAaLength: 1, strands: "forward" });
    expect(orfs).toHaveLength(1);
    expect(orfs[0]).toMatchObject({ range: { start: 2, end: 14 }, strand: 1, protein: "MKG", aaLength: 3, hasStop: true });
  });

  it("finds an ORF on the reverse strand with top-strand coordinates", () => {
    // Reverse complement of ATGAAAGGGTAA, so the ORF reads right-to-left.
    const seq = "CC" + reverseComplement("ATGAAAGGGTAA") + "CC";
    const orfs = findOrfs(seq, false, { minAaLength: 1, strands: "reverse" });
    expect(orfs).toHaveLength(1);
    expect(orfs[0]).toMatchObject({ range: { start: 2, end: 14 }, strand: -1, protein: "MKG" });
  });

  it("reads an ORF through the origin of a circular sequence", () => {
    //            0         1
    //            012345678901234
    const seq = "AAAGGGTAACCCATG"; // ATG at 12, then AAA GGG TAA across the origin
    const orfs = findOrfs(seq, true, { minAaLength: 1, strands: "forward" });
    const spanning = orfs.find((o) => o.range.start === 12);
    expect(spanning).toMatchObject({ range: { start: 12, end: 9 }, protein: "MKG", aaLength: 3 });
    expect(rangeLength(spanning!.range, seq.length, true)).toBe(12);
  });

  it("respects the minimum length", () => {
    expect(findOrfs("CCATGAAAGGGTAACC", false, { minAaLength: 10 })).toEqual([]);
  });
});

describe("motif search", () => {
  it("finds exact matches on both strands", () => {
    const hits = findMatches("AAGAATTCAA", "GAATTC", false, { bothStrands: true });
    // EcoRI is palindromic, so the same position is found on both strands.
    expect(hits).toHaveLength(2);
    expect(hits[0]!.range).toEqual({ start: 2, end: 8 });
    expect(new Set(hits.map((h) => h.strand))).toEqual(new Set([1, -1]));
  });

  it("finds a site spanning the origin", () => {
    //            0        1
    //            01234567890
    const seq = "TTCAAAAAGAA"; // GAA at 8-10, TTC at 0-2 -> GAATTC across the origin
    const hits = findMatches(seq, "GAATTC", true);
    expect(hits).toEqual([{ range: { start: 8, end: 3 }, strand: 1, mismatches: 0 }]);
  });

  it("does not wrap on a linear sequence", () => {
    expect(findMatches("TTCAAAAAGAA", "GAATTC", false)).toEqual([]);
  });

  it("honours degenerate patterns", () => {
    // BsaJI: CCNNGG
    const hits = findMatches("AACCATGGAA", "CCNNGG", false);
    expect(hits).toHaveLength(1);
    expect(hits[0]!.range).toEqual({ start: 2, end: 8 });
  });

  it("allows mismatches when asked", () => {
    expect(findMatches("AAGAATTGAA", "GAATTC", false)).toEqual([]);
    const near = findMatches("AAGAATTGAA", "GAATTC", false, { maxMismatches: 1 });
    expect(near).toHaveLength(1);
    expect(near[0]).toMatchObject({ mismatches: 1 });
  });
});

describe("option merging", () => {
  it("ignores undefined overrides so optional request fields keep defaults", () => {
    const defaults = { minLength: 18, maxLength: 30, targetTm: 60 };
    expect(withDefaults(defaults, { minLength: undefined, targetTm: 65 })).toEqual({ minLength: 18, maxLength: 30, targetTm: 65 });
    expect(withDefaults(defaults, undefined)).toEqual(defaults);
    expect(withDefaults(defaults, {})).toEqual(defaults);
    // A deliberate zero or empty string still overrides.
    expect(withDefaults({ trim: 20 }, { trim: 0 })).toEqual({ trim: 0 });
  });
});
