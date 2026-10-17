import { describe, expect, it } from "vitest";
import {
  assembleByEnds,
  assembleByHomology,
  flipPart,
  gibsonAssembly,
  gibsonOverlapTails,
  goldenGate,
  restrictionClone,
  type SourceMolecule,
} from "./assembly";
import { digest } from "./enzymes";
import type { BioFeature } from "./formats/types";
import { reverseComplement } from "./seq";

const feature = (name: string, start: number, end: number, strand: 1 | -1 = 1): BioFeature => ({
  name,
  type: "CDS",
  strand,
  segments: [{ start, end }],
  qualifiers: {},
});

describe("restriction cloning", () => {
  // A vector whose polylinker holds a short stuffer between EcoRI and HindIII.
  const vector: SourceMolecule = {
    id: "vec",
    name: "pVector",
    //         0-5     6-15        16-21    22-61
    sequence: "GAATTC" + "GCGCGCGCGC" + "AAGCTT" + "ACGTTGCATGCAGTCATTGCAACGTTGCATGCAGTCATTGC",
    isCircular: true,
    features: [feature("AmpR", 25, 55)],
  };
  const gene = "ATGACCATGATTACGGATTCACTGGCCGT"; // 29 bp, no EcoRI/HindIII sites
  const insert: SourceMolecule = {
    id: "ins",
    name: "myGene",
    sequence: "TTT" + "GAATTC" + gene + "AAGCTT" + "TTT",
    isCircular: false,
    features: [feature("myGene", 9, 9 + gene.length)],
  };

  it("ligates an insert into a cut vector", () => {
    const result = restrictionClone({ vector, insert, enzymes: ["EcoRI", "HindIII"] });
    expect(result.errors).toEqual([]);
    expect(result.products).toHaveLength(1);

    const product = result.products[0]!;
    expect(product.isCircular).toBe(true);
    // Backbone (vector minus stuffer) plus the insert fragment.
    expect(product.sequence).toHaveLength(result.vectorFragment!.length + result.insertFragment!.length);
    expect(product.sequence).toContain(gene);
    // The stuffer is gone.
    expect(product.sequence).not.toContain("GCGCGCGCGC");
    // Both junctions are sticky and carry the expected overhangs.
    expect(product.junctions.map((j) => j.sequence).sort()).toEqual(["AATT", "AGCT"]);
  });

  it("carries features from both molecules into the product", () => {
    const { products } = restrictionClone({ vector, insert, enzymes: ["EcoRI", "HindIII"] });
    const names = products[0]!.features.map((f) => f.name);
    expect(names).toContain("AmpR");
    expect(names).toContain("myGene");
    // The gene feature still sits on the gene.
    const geneFeature = products[0]!.features.find((f) => f.name === "myGene")!;
    const sliced = products[0]!.sequence.slice(geneFeature.segments[0]!.start, geneFeature.segments[0]!.end);
    expect(sliced).toBe(gene);
  });

  it("explains when an enzyme does not cut", () => {
    const result = restrictionClone({ vector, insert, enzymes: ["XhoI"] });
    expect(result.products).toEqual([]);
    expect(result.errors.join(" ")).toMatch(/do not cut/);
  });

  it("refuses to ligate incompatible overhangs", () => {
    // Cut the vector with EcoRI/HindIII but the insert with a different pair.
    const otherInsert: SourceMolecule = { ...insert, sequence: "TTT" + "GGATCC" + gene + "GGATCC" + "TTT" };
    const vectorFragments = digest(vector.sequence, true, ["EcoRI", "HindIII"]).fragments;
    const insertFragments = digest(otherInsert.sequence, false, ["BamHI"]).fragments;
    const result = assembleByEnds([
      { id: "v", name: "backbone", sequence: vectorFragments[0]!.sequence, leftEnd: vectorFragments[0]!.leftEnd, rightEnd: vectorFragments[0]!.rightEnd, allowFlip: false },
      { id: "i", name: "insert", sequence: insertFragments[1]!.sequence, leftEnd: insertFragments[1]!.leftEnd, rightEnd: insertFragments[1]!.rightEnd },
    ]);
    expect(result.products).toEqual([]);
    expect(result.errors.join(" ")).toMatch(/cannot be joined/);
    expect(result.errors.join(" ")).toMatch(/nothing to ligate to/);
  });
});

describe("Golden Gate", () => {
  // Each part: BsaI site, spacer, 4 nt overhang, body, next overhang, spacer, inward BsaI site.
  const part = (id: string, left: string, body: string, right: string): SourceMolecule => ({
    id,
    name: id,
    sequence: `GGTCTC` + "A" + left + body + right + "A" + reverseComplement("GGTCTC"),
    isCircular: false,
    features: [feature(id, 7, 7 + 4 + body.length)],
  });

  const promoter = part("promoter", "AATG", "CCCCCCCCCC", "GGTT");
  const cds = part("cds", "GGTT", "TTTTTTTTTT", "TCGA");
  const terminator = part("terminator", "TCGA", "ACACACACAC", "AATG");

  it("assembles parts in the order dictated by their overhangs", () => {
    const result = goldenGate({ parts: [promoter, cds, terminator], enzyme: "BsaI" });
    expect(result.errors).toEqual([]);
    expect(result.products).toHaveLength(1);

    const product = result.products[0]!;
    expect(product.isCircular).toBe(true);
    // Each released fragment is its overhang plus its body.
    expect(product.sequence).toHaveLength(3 * (4 + 10));
    expect(product.sequence).toBe("AATG" + "CCCCCCCCCC" + "GGTT" + "TTTTTTTTTT" + "TCGA" + "ACACACACAC");
    expect(product.order.map((o) => o.partId)).toEqual(["promoter", "cds", "terminator"]);
    expect(product.junctions.every((j) => j.kind === "sticky")).toBe(true);
  });

  it("keeps each part's features on its own sequence", () => {
    const product = goldenGate({ parts: [promoter, cds, terminator], enzyme: "BsaI" }).products[0]!;
    const cdsFeature = product.features.find((f) => f.name === "cds")!;
    const sliced = product.sequence.slice(cdsFeature.segments[0]!.start, cdsFeature.segments[0]!.end);
    expect(sliced).toBe("GGTT" + "TTTTTTTTTT");
  });

  it("rejects a non-Type-IIS enzyme", () => {
    const result = goldenGate({ parts: [promoter, cds, terminator], enzyme: "EcoRI" });
    expect(result.errors[0]).toMatch(/not a Type IIS enzyme/);
  });

  it("reports parts the enzyme does not release", () => {
    const broken: SourceMolecule = { id: "broken", name: "broken", sequence: "ACGTACGTACGTACGTACGT", isCircular: false };
    const result = goldenGate({ parts: [promoter, broken], enzyme: "BsaI" });
    expect(result.products).toEqual([]);
    expect(result.errors.join(" ")).toMatch(/cuts "broken" 0 time/);
  });

  it("warns when an overhang is reused, which allows several orders", () => {
    const duplicate = part("duplicate", "GGTT", "GAGAGAGAGA", "AATG");
    const result = goldenGate({ parts: [promoter, cds, terminator, duplicate], enzyme: "BsaI" });
    expect(result.warnings.join(" ")).toMatch(/appear more than once/);
  });
});

describe("Gibson assembly", () => {
  const o1 = "TTGCATGCAGTCATTGCAACGTTGC"; // 25 bp
  const o2 = "GGACCTTAAGCTCAGTACCGATTCA";
  const o3 = "CCATTGGCAGTACGATCAGTTACGG";
  const body = (n: string) => n.repeat(6); // 30 bp bodies

  const fragments: SourceMolecule[] = [
    { id: "f1", name: "backbone", sequence: o1 + body("ACGTA") + o2, isCircular: false, features: [feature("ori", 25, 55)] },
    { id: "f2", name: "insert", sequence: o2 + body("TTGCA") + o3, isCircular: false },
    { id: "f3", name: "marker", sequence: o3 + body("GGATC") + o1, isCircular: false },
  ];

  it("joins fragments by their shared ends, keeping the overlap once", () => {
    const result = gibsonAssembly({ fragments });
    expect(result.errors).toEqual([]);
    expect(result.products).toHaveLength(1);

    const product = result.products[0]!;
    expect(product.isCircular).toBe(true);
    expect(product.sequence).toHaveLength(3 * 25 + 3 * 30);
    expect(product.sequence).toBe(o1 + body("ACGTA") + o2 + body("TTGCA") + o3 + body("GGATC"));
    // Each overlap appears exactly once in the product.
    for (const overlap of [o1, o2, o3]) {
      expect(product.sequence.split(overlap)).toHaveLength(2);
    }
    expect(product.junctions.every((j) => j.kind === "homology")).toBe(true);
  });

  it("keeps features aligned after assembly", () => {
    const product = gibsonAssembly({ fragments }).products[0]!;
    const ori = product.features.find((f) => f.name === "ori")!;
    expect(product.sequence.slice(ori.segments[0]!.start, ori.segments[0]!.end)).toBe(body("ACGTA"));
  });

  it("assembles fragments supplied in the wrong order or orientation", () => {
    const shuffled = [fragments[0]!, { ...fragments[2]!, sequence: reverseComplement(fragments[2]!.sequence) }, fragments[1]!];
    const result = gibsonAssembly({ fragments: shuffled });
    expect(result.products).toHaveLength(1);
    expect(result.products[0]!.sequence).toHaveLength(3 * 25 + 3 * 30);
  });

  it("explains which fragment has no homology partner", () => {
    const orphan: SourceMolecule = { id: "orphan", name: "orphan", sequence: "ACGT".repeat(20), isCircular: false };
    const result = gibsonAssembly({ fragments: [...fragments, orphan] });
    expect(result.products).toEqual([]);
    expect(result.errors.join(" ")).toMatch(/"orphan" shares no end homology/);
  });

  it("warns about overlaps that are shorter than recommended", () => {
    const short = "TTGCATGCAGTCATTGC"; // 17 bp
    const result = assembleByHomology(
      [
        { id: "a", name: "a", sequence: "ACGTACGTACGTACGTACGTACGT" + short, leftEnd: { type: "blunt", overhang: "", enzyme: null }, rightEnd: { type: "blunt", overhang: "", enzyme: null } },
        { id: "b", name: "b", sequence: short + "GGCATTACGCATTACGCATTACG", leftEnd: { type: "blunt", overhang: "", enzyme: null }, rightEnd: { type: "blunt", overhang: "", enzyme: null } },
      ],
      { circular: false, minOverlap: 15 },
    );
    expect(result.products).toHaveLength(1);
    expect(result.warnings.join(" ")).toMatch(/is short; 20-40 bp is more reliable/);
  });

  it("designs primer tails that create the needed overlaps", () => {
    const tails = gibsonOverlapTails(o1 + "ACGTACGTAC", "INSERT", "GGGGTTTTAA" + o2, 20);
    expect(tails.forwardTail).toHaveLength(20);
    expect((o1 + "ACGTACGTAC").endsWith(tails.forwardTail)).toBe(true);
    expect(reverseComplement(tails.reverseTail)).toBe(("GGGGTTTTAA" + o2).slice(0, 20));
  });
});

describe("part manipulation", () => {
  it("flips a part, its ends and its features together", () => {
    const part = {
      id: "p",
      name: "p",
      sequence: "AATTCGGGGGGGGG",
      leftEnd: { type: "5" as const, overhang: "AATT", enzyme: "EcoRI" },
      rightEnd: { type: "blunt" as const, overhang: "", enzyme: "SmaI" },
      features: [feature("gene", 2, 8, 1)],
    };
    const flipped = flipPart(part);
    expect(flipped.sequence).toBe(reverseComplement(part.sequence));
    expect(flipped.leftEnd).toMatchObject({ enzyme: "SmaI", type: "blunt" });
    expect(flipped.rightEnd).toMatchObject({ enzyme: "EcoRI", overhang: "AATT" });
    expect(flipped.features![0]).toMatchObject({ strand: -1, segments: [{ start: 6, end: 12 }] });
    // Flipping twice is the identity.
    expect(flipPart(flipped).sequence).toBe(part.sequence);
    expect(flipPart(flipped).features![0]!.segments).toEqual(part.features[0]!.segments);
  });
});
