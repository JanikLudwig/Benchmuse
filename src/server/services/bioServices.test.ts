import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { writeGenBank } from "@/bio/formats/genbank";
import type { SequenceRecord } from "@/bio/formats/types";
import { reverseComplement, translate } from "@/bio/seq";
import { DEMO_PLASMID, GFP_RANGE } from "@/bio/testPlasmid";
import { createPgliteDb, type Db } from "../db/client";
import { MemoryBlobStore, setBlobStore } from "../storage/blobs";
import { createAlignment, getAlignmentView } from "./alignments";
import type { Actor } from "./audit";
import { createConstruct, simulateGibson, simulateGoldenGate, simulateRestrictionClone, saveSimulatedProduct } from "./cloning";
import { createEntity } from "./entities";
import { detectFormat, uploadFile } from "./files";
import { commitImport, exportEntity, importPastedSequence, previewImport } from "./importing";
import { getLineageGraph } from "./lineage";
import { createFolder, createProject, getProjectRootFolder } from "./projects";
import {
  changeOrigin,
  editSequence,
  flipSequence,
  runDigest,
  runGuideSearch,
  runOrfSearch,
  runPcr,
  runPrimerDesign,
  runProperties,
  runAutoAnnotate,
} from "./sequenceTools";
import { ensureUser } from "./users";

let db: Db;
let actor: Actor;
let folderId: string;

const encoder = new TextEncoder();

beforeAll(async () => {
  db = await createPgliteDb();
  actor = await ensureUser(db, { handle: "bio", name: "Bio Tester", email: "bio@example.com" });
});

beforeEach(async () => {
  setBlobStore(new MemoryBlobStore());
  const project = await createProject(db, actor, { name: `Project ${Math.random().toString(36).slice(2, 8)}` });
  folderId = (await getProjectRootFolder(db, project.id)).id;
});

/** The demo plasmid rendered as a GenBank file, as a scientist would receive it. */
function demoGenBank(name = "pDEMO"): string {
  const record: SequenceRecord = {
    name,
    description: "Demo expression construct",
    kind: "dna",
    isCircular: true,
    residues: DEMO_PLASMID,
    features: [
      { name: "T7 promoter", type: "promoter", strand: 1, segments: [{ start: 234, end: 252 }], qualifiers: {} },
      { name: "GFP", type: "CDS", strand: 1, segments: [{ start: GFP_RANGE.start, end: GFP_RANGE.end }], qualifiers: { codon_start: ["1"] } },
    ],
    format: "genbank",
  };
  return writeGenBank(record);
}

async function uploadGenBank(name = "pDEMO.gb") {
  return uploadFile(db, actor, { name, bytes: encoder.encode(demoGenBank()), folderId });
}

describe("file upload and format detection", () => {
  it("recognises GenBank, FASTA and AB1 from their contents", () => {
    expect(detectFormat(encoder.encode(demoGenBank()), "anything.txt")).toBe("genbank");
    expect(detectFormat(encoder.encode(">x desc\nACGT\n"), "anything.txt")).toBe("fasta");
    expect(detectFormat(new Uint8Array([0x41, 0x42, 0x49, 0x46, 0, 101]), "r.ab1")).toBe("ab1");
    expect(detectFormat(encoder.encode("a,b,c\n1,2,3\n"), "table.csv")).toBe("csv");
  });

  it("stores a file once even when uploaded twice", async () => {
    const first = await uploadGenBank();
    const second = await uploadGenBank("copy.gb");
    expect(first.sha256).toBe(second.sha256);
    expect(first.id).not.toBe(second.id);
    expect(first.detectedFormat).toBe("genbank");
    expect(first.sizeBytes).toBeGreaterThan(1000);
  });

  it("rejects an empty file", async () => {
    await expect(uploadFile(db, actor, { name: "empty.gb", bytes: new Uint8Array(), folderId })).rejects.toThrow(/empty/);
  });
});

describe("importing sequences", () => {
  it("previews what a file contains without writing anything", async () => {
    const file = await uploadGenBank();
    const preview = await previewImport(db, file.id);
    expect(preview.format).toBe("genbank");
    expect(preview.warnings).toEqual([]);
    expect(preview.candidates).toHaveLength(1);
    expect(preview.candidates[0]).toMatchObject({
      name: "pDEMO",
      entityType: "dna_sequence",
      length: DEMO_PLASMID.length,
      isCircular: true,
      featureCount: 2,
    });
  });

  it("imports a GenBank file into an entity with its features", async () => {
    const file = await uploadGenBank();
    const [entity] = await commitImport(db, actor, { fileId: file.id, folderId });
    // GenBank files store bases in lower case, and the importer preserves what the file said.
    expect(entity!.sequence!.toUpperCase()).toBe(DEMO_PLASMID);
    expect(entity!.isCircular).toBe(true);
    expect(entity!.sourceFileId).toBe(file.id);
    expect(entity!.features.map((f) => f.name).sort()).toEqual(["GFP", "T7 promoter"]);
    const gfp = entity!.features.find((f) => f.name === "GFP")!;
    expect(translate(entity!.sequence!.slice(gfp.segments[0]!.start, gfp.segments[0]!.end), { toStop: true })).toContain("MHHHHHH");
  });

  it("records where an imported entity came from", async () => {
    const file = await uploadGenBank();
    const [entity] = await commitImport(db, actor, { fileId: file.id, folderId });
    const { edges } = await getLineageGraph(db, entity!.id);
    expect(edges).toHaveLength(1);
    expect(edges[0]).toMatchObject({ method: "import", childEntityId: entity!.id });
    expect(edges[0]!.details).toMatchObject({ fileId: file.id });
  });

  it("adds library annotations when asked", async () => {
    const file = await uploadGenBank();
    const [plain] = await commitImport(db, actor, { fileId: file.id, folderId });
    const [annotated] = await commitImport(db, actor, { fileId: file.id, folderId, autoAnnotate: true, names: { 0: "pDEMO annotated" } });
    expect(annotated!.features.length).toBeGreaterThan(plain!.features.length);
    expect(annotated!.features.map((f) => f.name)).toContain("lac operator");
  });

  it("treats a short FASTA sequence as an oligo", async () => {
    const file = await uploadFile(db, actor, { name: "primer.fasta", bytes: encoder.encode(">P1 forward primer\nGTCATGCAGTTACCGATCAG\n"), folderId });
    const [entity] = await commitImport(db, actor, { fileId: file.id, folderId });
    expect(entity).toMatchObject({ entityType: "dna_oligo", oligoRole: "primer", name: "P1" });
  });

  it("imports pasted text with or without a header", async () => {
    const [withHeader] = await importPastedSequence(db, actor, { text: ">pPaste\nATGAAAGGGTTTCCC", folderId });
    expect(withHeader).toMatchObject({ name: "pPaste", sequence: "ATGAAAGGGTTTCCC" });
    const [bare] = await importPastedSequence(db, actor, { text: "atg aaa\nggg ttt", folderId, name: "Bare" });
    expect(bare!.sequence).toBe("atgaaagggttt");
  });

  it("round-trips an entity back out to GenBank", async () => {
    const file = await uploadGenBank();
    const [entity] = await commitImport(db, actor, { fileId: file.id, folderId });
    const exported = await exportEntity(db, entity!.id, "genbank");
    expect(exported.filename).toMatch(/\.gb$/);
    expect(exported.body).toContain("GFP");
    expect(exported.body).toContain("circular");

    const reimported = await uploadFile(db, actor, { name: "round.gb", bytes: encoder.encode(exported.body), folderId });
    const [again] = await commitImport(db, actor, { fileId: reimported.id, folderId });
    expect(again!.sequence!.toUpperCase()).toBe(DEMO_PLASMID.toUpperCase());
    expect(again!.features.map((f) => f.name).sort()).toEqual(["GFP", "T7 promoter"]);
  });

  it("exports FASTA too", async () => {
    const file = await uploadGenBank();
    const [entity] = await commitImport(db, actor, { fileId: file.id, folderId });
    const exported = await exportEntity(db, entity!.id, "fasta");
    expect(exported.body.startsWith(">")).toBe(true);
    expect(exported.body.replace(/^>.*\n/, "").replace(/\n/g, "").toUpperCase()).toBe(DEMO_PLASMID);
  });
});

describe("sequence tools", () => {
  async function importedPlasmid() {
    const file = await uploadGenBank();
    const [entity] = await commitImport(db, actor, { fileId: file.id, folderId });
    return entity!;
  }

  it("digests a plasmid and reports a gel", async () => {
    const entity = await importedPlasmid();
    const result = await runDigest(db, entity.id, { enzymes: ["EcoRI", "HindIII", "BamHI"] });
    expect(result.sites.map((s) => s.enzyme).sort()).toEqual(["BamHI", "EcoRI", "HindIII"]);
    // Three cuts on a circle give three fragments whose lengths sum to the plasmid.
    expect(result.fragments).toHaveLength(3);
    expect(result.fragments.reduce((n, f) => n + f.length, 0)).toBe(DEMO_PLASMID.length);
    expect(result.gel.lanes.length).toBe(2);
    expect(result.gel.lanes[1]!.bands.length).toBeGreaterThan(0);
  });

  it("lists enzymes that do not cut, for choosing a cloning site", async () => {
    const entity = await importedPlasmid();
    const result = await runDigest(db, entity.id, {});
    expect(result.nonCutters.length).toBeGreaterThan(0);
    expect(result.summary.find((s) => s.enzyme === "EcoRI")!.cuts).toBe(1);
  });

  it("rejects an unknown enzyme by name", async () => {
    const entity = await importedPlasmid();
    await expect(runDigest(db, entity.id, { enzymes: ["NotARealI"] })).rejects.toThrow(/Unknown enzyme/);
  });

  it("designs primers that amplify the requested region in simulation", async () => {
    const entity = await importedPlasmid();
    const { pairs } = await runPrimerDesign(db, entity.id, { target: GFP_RANGE, targetTm: 60 });
    expect(pairs.length).toBeGreaterThan(0);
    const best = pairs[0]!;
    const pcr = await runPcr(db, entity.id, best.forward.oligo, best.reverse.oligo);
    expect(pcr.products).toHaveLength(1);
    expect(pcr.products[0]!.length).toBe(best.productLength);
    expect(pcr.warnings).toEqual([]);
  });

  it("explains a PCR that cannot work", async () => {
    const entity = await importedPlasmid();
    const result = await runPcr(db, entity.id, "ACGTACGTACGTACGTACGT", "TGCATGCATGCATGCATGCA");
    expect(result.products).toEqual([]);
    expect(result.warnings.join(" ")).toMatch(/does not anneal/);
  });

  it("finds CRISPR guides inside a target window", async () => {
    const entity = await importedPlasmid();
    const { guides, enzyme } = await runGuideSearch(db, entity.id, { target: { start: 400, end: 500 }, limit: 10 });
    expect(enzyme).toBe("SpCas9");
    expect(guides.length).toBeGreaterThan(0);
    expect(guides.every((g) => g.cutSite >= 400 && g.cutSite < 500)).toBe(true);
    expect(guides[0]!.cloningOligos.top).toMatch(/^CACC/);
    expect(guides[0]!.spacer).toHaveLength(20);
  });

  it("finds the GFP open reading frame", async () => {
    const entity = await importedPlasmid();
    const { orfs } = await runOrfSearch(db, entity.id, { minAaLength: 100 });
    const gfp = orfs.find((o) => o.range.start === GFP_RANGE.start);
    expect(gfp).toBeDefined();
    expect(gfp!.protein.startsWith("MHHHHHH")).toBe(true);
  });

  it("reports composition and physical properties", async () => {
    const entity = await importedPlasmid();
    const whole = await runProperties(db, entity.id);
    expect(whole.length).toBe(DEMO_PLASMID.length);
    expect(whole.gc).toBeGreaterThan(0.3);
    expect(whole.molecularWeight).toBeGreaterThan(100000);
    const window = await runProperties(db, entity.id, { start: 0, end: 20 });
    expect(window.length).toBe(20);
    expect(window.tm).toBeGreaterThan(0);
  });

  it("suggests annotations that are not already present", async () => {
    const entity = await importedPlasmid();
    const { suggestions } = await runAutoAnnotate(db, entity.id);
    expect(suggestions.map((s) => s.name)).toContain("lac operator");
    expect(suggestions.map((s) => s.name)).not.toContain("T7 promoter");
  });

  it("edits a sequence and moves features with it", async () => {
    const entity = await importedPlasmid();
    const before = entity.features.find((f) => f.name === "GFP")!;
    const result = await editSequence(db, actor, entity.id, {
      edits: [{ start: 10, end: 10, insert: "GGGGGGGGGG" }],
      reason: "add a spacer",
    });
    const after = result.entity.features.find((f) => f.name === "GFP")!;
    expect(result.entity.sequence).toHaveLength(DEMO_PLASMID.length + 10);
    expect(after.segments[0]!.start).toBe(before.segments[0]!.start + 10);
    expect(result.removedFeatures).toEqual([]);
    // Feature identity survives the edit.
    expect(after.id).toBe(before.id);
  });

  it("refuses to edit a registered sequence", async () => {
    const entity = await createEntity(db, actor, { name: "locked", folderId, entityType: "dna_sequence", sequence: "ACGTACGTACGT" });
    const { registerEntity } = await import("./entities");
    const { createSchema } = await import("./schemas");
    const schema = await createSchema(db, actor, { kind: "entity", name: `S${Math.random()}`, entityType: "dna_sequence", nameTemplate: "LCK-{n:3}" });
    const withSchema = await createEntity(db, actor, { name: "locked2", folderId, schemaId: schema.id, sequence: "ACGTACGTACGT" });
    await registerEntity(db, actor, withSchema.id);
    await expect(editSequence(db, actor, withSchema.id, { edits: [{ start: 0, end: 1, insert: "" }] })).rejects.toThrow(/immutable/);
    expect(entity.id).toBeTruthy();
  });

  it("rotates the origin of a plasmid and keeps features on the same bases", async () => {
    const entity = await importedPlasmid();
    const gfpBefore = entity.features.find((f) => f.name === "GFP")!;
    const basesBefore = entity.sequence!.slice(gfpBefore.segments[0]!.start, gfpBefore.segments[0]!.end);
    const rotated = await changeOrigin(db, actor, entity.id, 500);
    const gfpAfter = rotated.features.find((f) => f.name === "GFP")!;
    const basesAfter = gfpAfter.segments.map((s) => rotated.sequence!.slice(s.start, s.end)).join("");
    expect(rotated.sequence).toHaveLength(DEMO_PLASMID.length);
    expect(basesAfter).toBe(basesBefore);
  });

  it("flips a molecule onto the other strand", async () => {
    const entity = await importedPlasmid();
    const flipped = await flipSequence(db, actor, entity.id);
    expect(flipped.sequence!.toUpperCase()).toBe(reverseComplement(DEMO_PLASMID));
    expect(flipped.features.find((f) => f.name === "GFP")!.strand).toBe(-1);
  });
});

describe("cloning workflows", () => {
  async function makeVectorAndInsert() {
    const gene = "ATGACCATGATTACGGATTCACTGGCCGTCGTTTTACAACGTCGTGACTGG";
    const vector = await createEntity(db, actor, {
      name: "pVector",
      folderId,
      entityType: "dna_sequence",
      isCircular: true,
      sequence: "GAATTC" + "GCGCGCGCGC" + "AAGCTT" + "ACGTTGCATGCAGTCATTGCAACGTTGCATGCAGTCATTGCTTACGGATCA",
      features: [{ name: "AmpR", type: "CDS", start: 25, end: 60 }],
    });
    const insert = await createEntity(db, actor, {
      name: "myGene",
      folderId,
      entityType: "dna_sequence",
      sequence: "TTT" + "GAATTC" + gene + "AAGCTT" + "TTT",
      features: [{ name: "myGene", type: "CDS", start: 9, end: 9 + gene.length }],
    });
    return { vector, insert, gene };
  }

  it("simulates a restriction clone and saves the product with its parents", async () => {
    const { vector, insert, gene } = await makeVectorAndInsert();
    const simulation = await simulateRestrictionClone(db, {
      vectorEntityId: vector.id,
      insertEntityId: insert.id,
      enzymes: ["EcoRI", "HindIII"],
    });
    expect(simulation.errors).toEqual([]);
    expect(simulation.products).toHaveLength(1);
    expect(simulation.products[0]!.sequence).toContain(gene);
    expect(simulation.vectorFragments.length).toBe(2);

    const product = await saveSimulatedProduct(db, actor, {
      simulation,
      productIndex: 0,
      name: "pVector-myGene",
      folderId,
    });
    expect(product.sequence).toBe(simulation.products[0]!.sequence);
    expect(product.isCircular).toBe(true);
    expect(product.features.map((f) => f.name).sort()).toEqual(["AmpR", "myGene"]);

    const { edges, nodes } = await getLineageGraph(db, product.id);
    const parents = edges.filter((e) => e.childEntityId === product.id);
    expect(parents).toHaveLength(2);
    expect(parents.every((p) => p.method === "restriction_ligation")).toBe(true);
    expect(nodes.map((n) => n.entityId)).toContain(vector.id);
    expect(nodes.map((n) => n.entityId)).toContain(insert.id);
  });

  it("explains a restriction clone that cannot work", async () => {
    const { vector, insert } = await makeVectorAndInsert();
    const simulation = await simulateRestrictionClone(db, {
      vectorEntityId: vector.id,
      insertEntityId: insert.id,
      enzymes: ["XhoI"],
    });
    expect(simulation.products).toEqual([]);
    expect(simulation.errors.join(" ")).toMatch(/do not cut/);
  });

  it("assembles parts by Golden Gate", async () => {
    const part = async (name: string, left: string, body: string, right: string) =>
      createEntity(db, actor, {
        name,
        folderId,
        entityType: "dna_sequence",
        sequence: "GGTCTC" + "A" + left + body + right + "A" + reverseComplement("GGTCTC"),
      });
    const parts = [
      await part("promoter", "AATG", "CCCCCCCCCC", "GGTT"),
      await part("cds", "GGTT", "TTTTTTTTTT", "TCGA"),
      await part("terminator", "TCGA", "ACACACACAC", "AATG"),
    ];
    const simulation = await simulateGoldenGate(db, { partEntityIds: parts.map((p) => p.id), enzyme: "BsaI" });
    expect(simulation.errors).toEqual([]);
    expect(simulation.products).toHaveLength(1);
    const expected = "AATG" + "CCCCCCCCCC" + "GGTT" + "TTTTTTTTTT" + "TCGA" + "ACACACACAC";
    expect(simulation.products[0]!.sequence.toUpperCase()).toBe(expected);
    expect(simulation.products[0]!.order.map((o) => o.name)).toEqual(["promoter", "cds", "terminator"]);
  });

  it("assembles fragments by Gibson homology", async () => {
    const o1 = "TTGCATGCAGTCATTGCAACGTTGC";
    const o2 = "GGACCTTAAGCTCAGTACCGATTCA";
    const o3 = "CCATTGGCAGTACGATCAGTTACGG";
    const make = (name: string, sequence: string) =>
      createEntity(db, actor, { name, folderId, entityType: "dna_sequence", sequence });
    const fragments = [
      await make("backbone", o1 + "ACGTA".repeat(6) + o2),
      await make("insert", o2 + "TTGCA".repeat(6) + o3),
      await make("marker", o3 + "GGATC".repeat(6) + o1),
    ];
    const simulation = await simulateGibson(db, { fragmentEntityIds: fragments.map((f) => f.id) });
    expect(simulation.errors).toEqual([]);
    expect(simulation.products[0]!.sequence).toHaveLength(3 * 25 + 3 * 30);
    expect(simulation.products[0]!.junctions.every((j) => j.kind === "homology")).toBe(true);
  });

  it("records a hand-built construct with its lineage", async () => {
    const { vector, insert } = await makeVectorAndInsert();
    const product = await createConstruct(db, actor, {
      name: "manual construct",
      folderId,
      sequence: "ACGTACGTACGTACGT",
      isCircular: true,
      method: "manual_edit",
      parents: [
        { entityId: vector.id, role: "backbone" },
        { entityId: insert.id, role: "insert" },
      ],
      details: { note: "built by hand" },
    });
    const parents = (await getLineageGraph(db, product.id)).edges.filter((e) => e.childEntityId === product.id);
    expect(parents.map((p) => p.role).sort()).toEqual(["backbone", "insert"]);
  });
});

describe("sequencing alignment", () => {
  async function plasmidEntity() {
    const file = await uploadGenBank();
    const [entity] = await commitImport(db, actor, { fileId: file.id, folderId });
    return entity!;
  }

  /** A Sanger-like read: a window of the reference, with quality tailing off at the ends. */
  function simulateRead(sequence: string, start: number, length: number, mutate?: (s: string) => string) {
    const window = sequence.slice(start, start + length);
    const bases = mutate ? mutate(window) : window;
    const qualities = bases.split("").map((_, i) => (i < 25 || i > bases.length - 25 ? 10 : 50));
    return { sequence: bases, qualities };
  }

  it("places clean reads and reports no differences", async () => {
    const entity = await plasmidEntity();
    const read = simulateRead(DEMO_PLASMID, 300, 600);
    const { alignment } = await createAlignment(db, actor, {
      name: "clean run",
      referenceEntityId: entity.id,
      reads: [{ name: "F01", ...read }],
    });
    const view = await getAlignmentView(db, alignment.id);
    expect(view.summary).toMatchObject({ total: 1, placed: 1, failed: 0, distinctVariants: 0 });
    expect(view.reads[0]!.strand).toBe(1);
    expect(view.reads[0]!.identity).toBe(100);
    expect(view.summary.coverage).toBeGreaterThan(0.3);
  });

  it("finds a point mutation and names its effect on the protein", async () => {
    const entity = await plasmidEntity();
    // Codon 12 of the CDS is CAG (Gln); C->T makes it TAG, a stop.
    const position = GFP_RANGE.start + 12 * 3;
    expect(DEMO_PLASMID.slice(position, position + 3)).toBe("CAG");
    const read = simulateRead(DEMO_PLASMID, 280, 600, (s) => {
      const at = position - 280;
      return s.slice(0, at) + "T" + s.slice(at + 1);
    });
    const { alignment } = await createAlignment(db, actor, {
      name: "mutant",
      referenceEntityId: entity.id,
      reads: [{ name: "F01", ...read }],
    });
    const view = await getAlignmentView(db, alignment.id);
    expect(view.variants).toHaveLength(1);
    const variant = view.variants[0]!;
    expect(variant).toMatchObject({ type: "substitution", refStart: position, queryBases: "T" });
    expect(variant.refBases.toUpperCase()).toBe("C");
    expect(variant.label).toBe(`g.${position + 1}C>T`);
    expect(variant.effects[0]).toMatchObject({ featureName: "GFP", consequence: "nonsense", proteinChange: "p.Gln13Ter" });
    expect(view.summary.consequences).toEqual({ nonsense: 1 });
  });

  it("aligns a reverse-strand read and reports it on reference coordinates", async () => {
    const entity = await plasmidEntity();
    const forward = simulateRead(DEMO_PLASMID, 400, 500);
    const { alignment } = await createAlignment(db, actor, {
      name: "reverse read",
      referenceEntityId: entity.id,
      reads: [{ name: "R01", sequence: reverseComplement(forward.sequence), qualities: [...forward.qualities].reverse() }],
    });
    const view = await getAlignmentView(db, alignment.id);
    const read = view.reads[0]!;
    expect(read.strand).toBe(-1);
    // Low-quality ends are trimmed first, so the placement sits inside the sequenced window.
    expect(read.trimStart).toBeGreaterThan(0);
    expect(read.refStart).toBeGreaterThanOrEqual(400);
    expect(read.refEnd).toBeLessThanOrEqual(900);
    // However the read was oriented, the placed span matches the length kept after trimming.
    expect(read.refEnd! - read.refStart!).toBe(read.trimEnd - read.trimStart);
    expect(view.variants).toEqual([]);
  });

  it("confirms a variant seen in both of two overlapping reads", async () => {
    const entity = await plasmidEntity();
    const position = GFP_RANGE.start + 30;
    const mutate = (offset: number) => (s: string) => {
      const at = position - offset;
      return s.slice(0, at) + (s[at] === "A" ? "C" : "A") + s.slice(at + 1);
    };
    const { alignment } = await createAlignment(db, actor, {
      name: "two reads",
      referenceEntityId: entity.id,
      reads: [
        { name: "F01", ...simulateRead(DEMO_PLASMID, 280, 500, mutate(280)) },
        { name: "F02", ...simulateRead(DEMO_PLASMID, 300, 500, mutate(300)) },
      ],
    });
    const view = await getAlignmentView(db, alignment.id);
    expect(view.summary.placed).toBe(2);
    expect(view.variants).toHaveLength(1);
    expect(view.variants[0]!.supportingReads).toBe(2);
    expect(view.variants[0]!.coveringReads).toBe(2);
    expect(view.variants[0]!.confirmed).toBe(true);
  });

  it("keeps a read that does not match, with a reason", async () => {
    const entity = await plasmidEntity();
    const junk = "GGGGGGGGGGCCCCCCCCCCAAAAAAAAAATTTTTTTTTT".repeat(8);
    const { alignment } = await createAlignment(db, actor, {
      name: "bad read",
      referenceEntityId: entity.id,
      reads: [{ name: "junk", sequence: junk, qualities: new Array(junk.length).fill(50) }],
    });
    const view = await getAlignmentView(db, alignment.id);
    expect(view.summary).toMatchObject({ placed: 0, failed: 1 });
    expect(view.reads[0]!.failureReason).toMatch(/does not match|different template/);
  });

  it("trims poor-quality ends before aligning", async () => {
    const entity = await plasmidEntity();
    const window = DEMO_PLASMID.slice(400, 900);
    // Thirty bases of noise at the start, called with low quality.
    const noisy = "GTGTGTGTGTGTGTGTGTGTGTGTGTGTGT" + window;
    const qualities = noisy.split("").map((_, i) => (i < 30 ? 4 : 50));
    const { alignment } = await createAlignment(db, actor, {
      name: "noisy",
      referenceEntityId: entity.id,
      reads: [{ name: "F01", sequence: noisy, qualities }],
    });
    const view = await getAlignmentView(db, alignment.id);
    expect(view.reads[0]!.trimStart).toBeGreaterThanOrEqual(30);
    expect(view.reads[0]!.strand).toBe(1);
    expect(view.variants).toEqual([]);
  });

  it("ignores a difference whose base call is poor", async () => {
    const entity = await plasmidEntity();
    const window = DEMO_PLASMID.slice(400, 900);
    const at = 250;
    const mutated = window.slice(0, at) + (window[at] === "A" ? "C" : "A") + window.slice(at + 1);
    const qualities = mutated.split("").map((_, i) => (i === at ? 6 : 50));
    const { alignment } = await createAlignment(db, actor, {
      name: "low quality call",
      referenceEntityId: entity.id,
      reads: [{ name: "F01", sequence: mutated, qualities }],
      settings: { trimQuality: 0, minVariantQuality: 20 },
    });
    const view = await getAlignmentView(db, alignment.id);
    expect(view.reads[0]!.strand).toBe(1);
    expect(view.variants).toEqual([]);
  });

  it("refuses an alignment with no reads", async () => {
    const entity = await plasmidEntity();
    await expect(
      createAlignment(db, actor, { name: "empty", referenceEntityId: entity.id, reads: [] }),
    ).rejects.toThrow(/at least one read/);
  });
});
