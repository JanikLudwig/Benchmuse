import { describe, expect, it } from "vitest";
import {
  COMMON_ENZYMES,
  digest,
  endsCompatible,
  ENZYMES,
  findCutSites,
  getEnzyme,
  isoschizomers,
  summarizeDigest,
} from "./enzymes";

describe("enzyme table", () => {
  it("parses palindromic, blunt and Type IIS notations", () => {
    expect(getEnzyme("EcoRI")).toMatchObject({ site: "GAATTC", cutTop: 1, cutBottom: 5, overhangType: "5", overhangLength: 4, palindromic: true, isTypeIIS: false });
    expect(getEnzyme("PstI")).toMatchObject({ site: "CTGCAG", cutTop: 5, cutBottom: 1, overhangType: "3", overhangLength: 4 });
    expect(getEnzyme("SmaI")).toMatchObject({ site: "CCCGGG", cutTop: 3, cutBottom: 3, overhangType: "blunt", overhangLength: 0 });
    // BsaI cuts 1/5 nt past a 6 bp site, leaving a 4 nt 5' overhang.
    expect(getEnzyme("BsaI")).toMatchObject({ site: "GGTCTC", cutTop: 7, cutBottom: 11, isTypeIIS: true, overhangType: "5", overhangLength: 4, palindromic: false });
    expect(getEnzyme("BtsI")).toMatchObject({ cutTop: 8, cutBottom: 6, overhangType: "3", overhangLength: 2 });
  });

  it("is case-insensitive and finds isoschizomers", () => {
    expect(getEnzyme("ecori")?.name).toBe("EcoRI");
    expect(isoschizomers(getEnzyme("BsmBI")!).map((e) => e.name)).toEqual(["Esp3I"]);
    expect(isoschizomers(getEnzyme("SapI")!).map((e) => e.name)).toEqual(["BspQI"]);
  });

  it("ships a usable catalogue", () => {
    expect(ENZYMES.length).toBeGreaterThan(140);
    expect(COMMON_ENZYMES.length).toBeGreaterThan(30);
    expect(ENZYMES.every((e) => e.site.length >= 4)).toBe(true);
  });
});

describe("cut sites", () => {
  it("places a palindromic cut once, on the right bases", () => {
    //            0123456789
    const seq = "AAGAATTCAA";
    const sites = findCutSites(seq, false, ["EcoRI"]);
    expect(sites).toHaveLength(1);
    expect(sites[0]).toMatchObject({ topCut: 3, bottomCut: 7, overhang: "AATT", overhangType: "5", siteRange: { start: 2, end: 8 } });
  });

  it("reports 3' overhangs with the overhang bases between the cuts", () => {
    const sites = findCutSites("AACTGCAGAA", false, ["PstI"]);
    expect(sites[0]).toMatchObject({ topCut: 7, bottomCut: 3, overhang: "TGCA", overhangType: "3" });
  });

  it("cuts downstream of a Type IIS site on the top strand", () => {
    //            0 1 2 3 4 5 6 7 8 9 ...
    const seq = "AAGGTCTCAGGGGAAA";
    const sites = findCutSites(seq, false, ["BsaI"]);
    expect(sites[0]).toMatchObject({ siteRange: { start: 2, end: 8 }, strand: 1, topCut: 9, bottomCut: 13, overhang: "GGGG" });
  });

  it("cuts upstream when a Type IIS site is on the bottom strand", () => {
    // GAGACC is the reverse complement of the BsaI site, so the enzyme cuts to its left.
    const seq = "ACGTACGTAC" + "GAGACC" + "AAAA";
    const sites = findCutSites(seq, false, ["BsaI"]);
    expect(sites[0]).toMatchObject({ strand: -1, topCut: 5, bottomCut: 9, overhang: "CGTA" });
  });

  it("skips Type IIS sites whose cut falls off the end of a linear molecule", () => {
    expect(findCutSites("AAAGGTCTCAG", false, ["BsaI"])).toEqual([]);
    // ...but the same site cuts on a circle, where the cut wraps round.
    expect(findCutSites("AAAGGTCTCAG", true, ["BsaI"])).toHaveLength(1);
  });

  it("finds a site that spans the origin of a plasmid", () => {
    //            0        1
    //            01234567890
    const seq = "TTCAAAAAGAA"; // GAATTC across the origin
    const sites = findCutSites(seq, true, ["EcoRI"]);
    expect(sites).toHaveLength(1);
    expect(sites[0]).toMatchObject({ topCut: 9, bottomCut: 2, overhang: "AATT" });
  });
});

describe("digestion", () => {
  //                    0    5      11        20      26
  const plasmid = "AAAAA" + "GAATTC" + "TTTTTTTTT" + "GGATCC" + "CCCCCCCCCCCCCC"; // 40 bp

  it("splits a circular molecule into one fragment per cut", () => {
    expect(plasmid).toHaveLength(40);
    const { fragments } = digest(plasmid, true, ["EcoRI", "BamHI"]);
    expect(fragments.map((f) => f.length)).toEqual([15, 25]);
    expect(fragments.map((f) => f.sequence.length)).toEqual([15, 25]);
    expect(fragments[0]).toMatchObject({
      leftEnd: { enzyme: "EcoRI", overhang: "AATT", type: "5" },
      rightEnd: { enzyme: "BamHI", overhang: "GATC", type: "5" },
    });
    // The second fragment wraps the origin.
    expect(fragments[1]!.sequence.startsWith("GATCC")).toBe(true);
    expect(fragments[1]!.sequence.endsWith("AAAAAG")).toBe(true);
  });

  it("splits a linear molecule into cuts + 1 fragments with natural outer ends", () => {
    const { fragments } = digest(plasmid, false, ["EcoRI", "BamHI"]);
    expect(fragments.map((f) => f.length)).toEqual([6, 15, 19]);
    expect(fragments[0]!.leftEnd.enzyme).toBeNull();
    expect(fragments[2]!.rightEnd.enzyme).toBeNull();
    expect(fragments.map((f) => f.sequence).join("")).toBe(plasmid);
  });

  it("returns the intact molecule when nothing cuts", () => {
    const { fragments } = digest(plasmid, true, ["XhoI"]);
    expect(fragments).toHaveLength(1);
    expect(fragments[0]).toMatchObject({ length: 40, isCircular: true });
  });

  it("summarises cut counts per enzyme", () => {
    const sites = findCutSites(plasmid, true, COMMON_ENZYMES);
    const summary = summarizeDigest(sites);
    const single = summary.filter((s) => s.cuts === 1).map((s) => s.enzyme.name);
    expect(single).toContain("EcoRI");
    expect(single).toContain("BamHI");
    expect(summary.find((s) => s.enzyme.name === "EcoRI")!.positions).toEqual([6]);
  });
});

describe("end compatibility", () => {
  const overhangOf = (seq: string, enzyme: string) => findCutSites(seq, false, [enzyme])[0]!;

  it("matches classic compatible pairs", () => {
    // EcoRI and MfeI both leave AATT; BamHI and BglII both leave GATC.
    const ecoRI = overhangOf("AAGAATTCAA", "EcoRI");
    const mfeI = overhangOf("AACAATTGAA", "MfeI");
    expect(mfeI.overhang).toBe("AATT");
    expect(endsCompatible(
      { type: ecoRI.overhangType, overhang: ecoRI.overhang, enzyme: "EcoRI" },
      { type: mfeI.overhangType, overhang: mfeI.overhang, enzyme: "MfeI" },
    )).toBe(true);

    const bamHI = overhangOf("AAGGATCCAA", "BamHI");
    const bglII = overhangOf("AAAGATCTAA", "BglII");
    expect([bamHI.overhang, bglII.overhang]).toEqual(["GATC", "GATC"]);
  });

  it("rejects mismatched overhangs and mixed types", () => {
    expect(endsCompatible({ type: "5", overhang: "AATT", enzyme: "EcoRI" }, { type: "5", overhang: "GATC", enzyme: "BamHI" })).toBe(false);
    expect(endsCompatible({ type: "5", overhang: "TGCA", enzyme: null }, { type: "3", overhang: "TGCA", enzyme: "PstI" })).toBe(false);
    expect(endsCompatible({ type: "blunt", overhang: "", enzyme: "SmaI" }, { type: "blunt", overhang: "", enzyme: null })).toBe(true);
  });
});
