import { describe, expect, it } from "vitest";
import { isFasta, parseFasta, writeFasta } from "./fasta";
import { isGenBank, parseGenBank, writeGenBank } from "./genbank";
import { formatLocation, parseLocation } from "./location";

describe("location grammar", () => {
  it.each([
    ["467", [{ start: 466, end: 467 }], 1],
    ["340..565", [{ start: 339, end: 565 }], 1],
    ["complement(340..565)", [{ start: 339, end: 565 }], -1],
    ["join(12..78,134..202)", [{ start: 11, end: 78 }, { start: 133, end: 202 }], 1],
    ["complement(join(12..78,134..202))", [{ start: 11, end: 78 }, { start: 133, end: 202 }], -1],
    // The other way round: segments listed 3'->5', each complemented.
    ["join(complement(134..202),complement(12..78))", [{ start: 11, end: 78 }, { start: 133, end: 202 }], -1],
  ])("parses %s", (text, segments, strand) => {
    const parsed = parseLocation(text);
    expect(parsed.segments).toEqual(segments);
    expect(parsed.strand).toBe(strand);
  });

  it("tracks partial ends through complement", () => {
    expect(parseLocation("<1..206")).toMatchObject({ partial5: true, partial3: false });
    expect(parseLocation("complement(1..>206)")).toMatchObject({ strand: -1, partial5: true, partial3: false });
  });

  it("handles between-base and remote locations", () => {
    expect(parseLocation("102^103").between).toBe(true);
    expect(parseLocation("J00194.1:100..202").remote).toEqual(["J00194.1"]);
  });

  it.each([
    "340..565",
    "complement(340..565)",
    "join(12..78,134..202)",
    "complement(join(12..78,134..202))",
    "<1..206",
    "complement(1..>206)",
  ])("round-trips %s", (text) => {
    const parsed = parseLocation(text);
    expect(formatLocation(parsed)).toBe(text);
  });

  it("reports a bad location instead of guessing", () => {
    expect(() => parseLocation("1..notanumber")).toThrow();
  });
});

// A compact but realistic plasmid record: circular, a complement CDS with a wrapped translation,
// an origin-spanning join, a SnapGene-style colour note and a partial feature.
const PLASMID_GB = `LOCUS       pDEMO                     60 bp    DNA     circular SYN 17-OCT-2026
DEFINITION  Demo plasmid for parser tests.
ACCESSION   .
VERSION     .
KEYWORDS    .
SOURCE      synthetic DNA construct
  ORGANISM  synthetic DNA construct
FEATURES             Location/Qualifiers
     source          1..60
                     /organism="synthetic DNA construct"
                     /mol_type="other DNA"
     CDS             complement(4..15)
                     /codon_start=1
                     /gene="tinyR"
                     /product="tiny resistance protein"
                     /translation="MKG
                     V"
                     /ApEinfo_fwdcolor="#ff7f50"
     misc_feature    join(55..60,1..3)
                     /label="ori-spanning"
                     /note="color: #1e90ff"
     promoter        <20..30
                     /label="pTrunc"
ORIGIN
        1 atgaaagggt ttcccgggaa attttgggcc cgggaaattt tgggcccggg aaattttggg
//
`;

describe("GenBank", () => {
  const { records, warnings } = parseGenBank(PLASMID_GB);
  const record = records[0]!;

  it("detects the format", () => {
    expect(isGenBank(PLASMID_GB)).toBe(true);
    expect(isGenBank(">x\nATGC")).toBe(false);
  });

  it("reads the LOCUS header and sequence", () => {
    expect(warnings).toEqual([]);
    expect(records).toHaveLength(1);
    expect(record).toMatchObject({ name: "pDEMO", isCircular: true, kind: "dna", description: "Demo plasmid for parser tests." });
    expect(record.residues).toHaveLength(60);
    expect(record.residues.startsWith("atgaaagggttt")).toBe(true);
  });

  it("reads features, names, strands and colours", () => {
    expect(record.features.map((f) => f.type)).toEqual(["source", "CDS", "misc_feature", "promoter"]);
    const cds = record.features[1]!;
    expect(cds).toMatchObject({ name: "tinyR", strand: -1, segments: [{ start: 3, end: 15 }], color: "#ff7f50" });
    // The wrapped /translation is rejoined without a space.
    expect(cds.qualifiers.translation).toEqual(["MKGV"]);
    expect(cds.qualifiers.product).toEqual(["tiny resistance protein"]);
  });

  it("keeps an origin-spanning join as two segments", () => {
    const ori = record.features[2]!;
    expect(ori.segments).toEqual([{ start: 54, end: 60 }, { start: 0, end: 3 }]);
    expect(ori.color).toBe("#1e90ff"); // parsed out of the SnapGene note
  });

  it("marks partial ends", () => {
    expect(record.features[3]).toMatchObject({ name: "pTrunc", partial5: true });
  });

  it("round-trips through the writer without losing structure", () => {
    const written = writeGenBank(record);
    const reparsed = parseGenBank(written).records[0]!;
    expect(reparsed.residues).toBe(record.residues);
    expect(reparsed.isCircular).toBe(true);
    expect(reparsed.name).toBe("pDEMO");
    expect(reparsed.features.map((f) => ({ name: f.name, type: f.type, strand: f.strand, segments: f.segments, color: f.color }))).toEqual(
      record.features.map((f) => ({ name: f.name, type: f.type, strand: f.strand, segments: f.segments, color: f.color })),
    );
    expect(reparsed.features[1]!.qualifiers.translation).toEqual(["MKGV"]);
    expect(reparsed.features[3]!.partial5).toBe(true);
  });

  it("writes sequence blocks in the standard 6x10 layout", () => {
    const origin = writeGenBank(record).split("ORIGIN\n")[1]!.split("\n")[0]!;
    expect(origin).toBe("        1 atgaaagggt ttcccgggaa attttgggcc cgggaaattt tgggcccggg aaattttggg");
  });

  it("survives a truncated or malformed record", () => {
    const broken = parseGenBank("LOCUS       bad\nFEATURES             Location/Qualifiers\n     CDS             nonsense..x\nORIGIN\n        1 atgc\n//\n");
    expect(broken.records[0]!.residues).toBe("atgc");
    expect(broken.records[0]!.features).toEqual([]);
    expect(broken.warnings.some((w) => /unparseable location/.test(w.message))).toBe(true);
  });

  it("reads multi-record files, with or without terminators", () => {
    const two = parseGenBank(PLASMID_GB + PLASMID_GB.replace("pDEMO", "pDEMO2"));
    expect(two.records.map((r) => r.name)).toEqual(["pDEMO", "pDEMO2"]);
  });
});

describe("FASTA", () => {
  const text = ">pGFP tac promoter construct\nATGAAAGGG\nTTTCCC\n>protein\nMSKGEELFT\n";

  it("detects the format and reads records", () => {
    expect(isFasta(text)).toBe(true);
    const { records } = parseFasta(text);
    expect(records).toHaveLength(2);
    expect(records[0]).toMatchObject({ name: "pGFP", description: "tac promoter construct", residues: "ATGAAAGGGTTTCCC", kind: "dna" });
    expect(records[1]).toMatchObject({ name: "protein", kind: "aa" });
  });

  it("round-trips", () => {
    const { records } = parseFasta(text);
    expect(parseFasta(writeFasta(records)).records.map((r) => r.residues)).toEqual(records.map((r) => r.residues));
  });

  it("accepts headerless sequence with a warning", () => {
    const { records, warnings } = parseFasta("ATGCATGC\nATGC\n");
    expect(records[0]!.residues).toBe("ATGCATGCATGC");
    expect(warnings).toHaveLength(1);
  });
});
