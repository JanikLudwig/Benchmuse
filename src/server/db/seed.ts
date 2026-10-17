/**
 * Demo data for local development: `npm run db:seed`.
 *
 * Builds a small but realistic project: an expression plasmid with a pUC19 polylinker, the
 * primers used to clone it, a derived construct with recorded lineage, a notebook entry with
 * results, and a Sanger sequencing run that finds a real mutation.
 *
 * Idempotent: it does nothing if the demo project already exists.
 */
import { eq } from "drizzle-orm";
import { COMMON_ENZYMES, findCutSites } from "@/bio/enzymes";
import { getPart } from "@/bio/features/library";
import { reverseComplement, translate } from "@/bio/seq";
import { GFP_CDS, GFP_PROTEIN, PUC19_MCS } from "@/bio/testPlasmid";
import { createAlignment } from "../services/alignments";
import { createConstruct } from "../services/cloning";
import { createEntity, registerEntity } from "../services/entities";
import { createEntry, createResults } from "../services/entries";
import { createFolder, createProject, getProjectRootFolder } from "../services/projects";
import { createDropdown, createSchema } from "../services/schemas";
import { createUser } from "../services/auth";
import { getDb } from "./client";
import { projects, users } from "./schema";

const DEMO_PROJECT = "GFP expression demo";

const partSeq = (name: string): string => {
  const part = getPart(name);
  if (!part) throw new Error(`unknown part ${name}`);
  return part.sequence;
};

/** Deterministic filler with balanced composition, so the demo is identical on every machine. */
function filler(length: number, seed: number): string {
  let x = seed >>> 0;
  let out = "";
  while (out.length < length) {
    x = (Math.imul(x, 1103515245) + 12345) >>> 0;
    out += "ACGT"[x >>> 30];
  }
  return out.slice(0, length);
}

interface Block {
  name?: string;
  type?: string;
  strand?: 1 | -1;
  seq: string;
  note?: string;
}

/**
 * Remove restriction sites that the random filler created by chance, leaving the sites inside
 * protected regions (the polylinker) alone. A real cloning vector has a unique-cutting
 * polylinker, and the demo is far more useful if this one does too.
 */
function removeStraySites(sequence: string, protectedRanges: { start: number; end: number }[]): string {
  let current = sequence;
  for (let pass = 0; pass < 200; pass++) {
    const stray = findCutSites(current, true, COMMON_ENZYMES).find((site) => {
      const { start, end } = site.siteRange;
      return !protectedRanges.some((r) => start >= r.start && end <= r.end);
    });
    if (!stray) return current;
    // Change the middle base of the recognition site to something that cannot match it.
    const middle = Math.floor((stray.siteRange.start + stray.siteRange.end) / 2) % current.length;
    const replacement = current[middle] === "A" ? "C" : "A";
    current = current.slice(0, middle) + replacement + current.slice(middle + 1);
  }
  return current;
}

/** Assemble the plasmid from labelled blocks so feature coordinates cannot drift. */
function buildPlasmid(blocks: Block[]): {
  sequence: string;
  features: { name: string; type: string; strand: 1 | -1; start: number; end: number; qualifiers?: Record<string, string[]> }[];
} {
  let sequence = "";
  const features: { name: string; type: string; strand: 1 | -1; start: number; end: number; qualifiers?: Record<string, string[]> }[] = [];
  for (const block of blocks) {
    const start = sequence.length;
    sequence += block.seq;
    if (block.name) {
      features.push({
        name: block.name,
        type: block.type ?? "misc_feature",
        strand: block.strand ?? 1,
        start,
        end: sequence.length,
        ...(block.note ? { qualifiers: { note: [block.note] } } : {}),
      });
    }
  }
  return { sequence, features };
}

async function main() {
  const db = await getDb();
  const [existing] = await db.select().from(projects).where(eq(projects.name, DEMO_PROJECT));
  if (existing) {
    console.log(`"${DEMO_PROJECT}" already exists; nothing to do.`);
    return;
  }
  // A real account, so the seeded instance can be signed into straight away.
  const password = process.env.BENCHMUSE_SEED_PASSWORD ?? "benchmuse-demo";
  const actor =
    (await db.select().from(users).where(eq(users.handle, "dev")))[0] ??
    (await createUser(db, { handle: "dev", name: "Dev Scientist", email: "dev@benchmuse.local", password, role: "admin" }));

  // ---------------------------------------------------------------------------------------
  // Schemas

  const resistance = await createDropdown(db, actor, { name: "Antibiotic resistance", options: ["Ampicillin", "Kanamycin", "Chloramphenicol"] });
  const host = await createDropdown(db, actor, { name: "Host organism", options: ["E. coli", "S. cerevisiae", "HEK293"] });
  const opt = (dropdown: typeof resistance, name: string) => dropdown.options.find((o) => o.name === name)!.id;

  const plasmidSchema = await createSchema(db, actor, {
    kind: "entity",
    name: "Plasmid",
    entityType: "dna_sequence",
    nameTemplate: "PLS-{n:4}",
    description: "Circular DNA constructs",
    fields: [
      { name: "resistance", displayName: "Resistance", type: "dropdown", dropdownId: resistance.id, isRequired: true },
      { name: "copy_number", displayName: "Copy number", type: "integer" },
      { name: "insert_description", displayName: "Insert", type: "text" },
    ],
  });
  const strainSchema = await createSchema(db, actor, {
    kind: "entity",
    name: "Strain",
    entityType: "custom",
    nameTemplate: "STR-{n:3}",
    fields: [
      { name: "host", displayName: "Host", type: "dropdown", dropdownId: host.id, isRequired: true },
      { name: "plasmids", displayName: "Plasmids", type: "entity_link", targetSchemaId: plasmidSchema.id, isMulti: true },
      { name: "genotype", displayName: "Genotype", type: "text" },
      { name: "received_on", displayName: "Received on", type: "date" },
    ],
  });
  const oligoSchema = await createSchema(db, actor, {
    kind: "entity",
    name: "Oligo",
    entityType: "dna_oligo",
    nameTemplate: "OLI-{n:3}",
    fields: [{ name: "purpose", displayName: "Purpose", type: "text" }],
  });
  const assaySchema = await createSchema(db, actor, {
    kind: "result",
    name: "Plate reader fluorescence",
    fields: [
      { name: "sample", displayName: "Sample", type: "entity_link", targetSchemaId: strainSchema.id, isRequired: true },
      { name: "induction_mm", displayName: "IPTG (mM)", type: "float", isRequired: true },
      { name: "od600", displayName: "OD600", type: "float" },
      { name: "fluorescence_rfu", displayName: "Fluorescence (RFU)", type: "float", isRequired: true },
    ],
  });

  // ---------------------------------------------------------------------------------------
  // Project structure

  const project = await createProject(db, actor, {
    name: DEMO_PROJECT,
    description: "Express GFP in E. coli, verify the construct by sequencing, and measure induction.",
  });
  const root = await getProjectRootFolder(db, project.id);
  const constructs = await createFolder(db, actor, { name: "Constructs", projectId: project.id });
  const oligos = await createFolder(db, actor, { name: "Oligos", projectId: project.id });
  const strains = await createFolder(db, actor, { name: "Strains", projectId: project.id });
  const notebook = await createFolder(db, actor, { name: "Notebook", projectId: project.id });

  // ---------------------------------------------------------------------------------------
  // pGFP-tac: a T7/lac expression construct with a pUC19 polylinker

  const built = buildPlasmid([
    { seq: filler(60, 7) },
    { name: "M13 fwd", type: "primer_bind", seq: partSeq("M13 fwd"), note: "M13/pUC forward sequencing primer" },
    { seq: "GTT" },
    {
      name: "MCS",
      type: "misc_feature",
      seq: PUC19_MCS,
      note: "pUC19 polylinker: EcoRI, SacI, KpnI, SmaI, BamHI, XbaI, SalI, PstI, SphI, HindIII",
    },
    { seq: filler(30, 11) },
    { name: "T7 promoter", type: "promoter", seq: partSeq("T7 promoter") },
    { name: "lac operator", type: "protein_bind", seq: partSeq("lac operator"), note: "LacI binding site" },
    { seq: "ACC" },
    { name: "RBS", type: "RBS", seq: partSeq("strong RBS") },
    { seq: "TACAT" },
    {
      name: "GFP",
      type: "CDS",
      seq: "ATG" + partSeq("6xHis") + partSeq("TEV site") + GFP_CDS.slice(3),
      note: "His-tagged GFP with a TEV cleavage site",
    },
    { seq: filler(25, 23) },
    { name: "T7 terminator", type: "terminator", seq: partSeq("T7 terminator") },
    { seq: filler(120, 29) },
    { name: "M13 rev", type: "primer_bind", strand: -1, seq: reverseComplement(partSeq("M13 rev")) },
    { seq: filler(60, 31) },
    { name: "AmpR", type: "CDS", strand: -1, seq: filler(861, 37), note: "beta-lactamase (placeholder sequence)" },
    { seq: filler(90, 41) },
    { name: "ori", type: "rep_origin", seq: filler(589, 43), note: "pUC origin of replication (placeholder sequence)" },
    { seq: filler(80, 47) },
  ]);

  // Keep the polylinker, promoter, tags and coding sequence intact; clean the filler around them.
  const protectedRanges = built.features
    .filter((f) => ["MCS", "GFP", "T7 promoter", "lac operator", "RBS", "T7 terminator", "M13 fwd", "M13 rev"].includes(f.name))
    .map((f) => ({ start: f.start, end: f.end }));
  built.sequence = removeStraySites(built.sequence, protectedRanges);

  const pGFP = await createEntity(db, actor, {
    name: "pGFP-tac",
    folderId: constructs.id,
    schemaId: plasmidSchema.id,
    sequence: built.sequence,
    isCircular: true,
    fields: { resistance: opt(resistance, "Ampicillin"), copy_number: 500, insert_description: "His-TEV-GFP under T7/lac control" },
    features: built.features,
  });
  const gfpFeature = built.features.find((f) => f.name === "GFP")!;
  if (!translate(built.sequence.slice(gfpFeature.start, gfpFeature.end), { toStop: true }).endsWith(GFP_PROTEIN.slice(1))) {
    throw new Error("demo GFP coding sequence does not translate to the published protein");
  }
  await registerEntity(db, actor, pGFP.id);

  // The empty vector: the same backbone with the insert removed.
  const insertLength = gfpFeature.end - gfpFeature.start;
  const pEmpty = await createEntity(db, actor, {
    name: "pEmpty-tac",
    folderId: constructs.id,
    schemaId: plasmidSchema.id,
    sequence: built.sequence.slice(0, gfpFeature.start) + built.sequence.slice(gfpFeature.end),
    isCircular: true,
    fields: { resistance: opt(resistance, "Ampicillin"), copy_number: 500, insert_description: "Empty vector control" },
    features: built.features
      .filter((f) => f.name !== "GFP")
      .map((f) => ({
        ...f,
        start: f.start > gfpFeature.start ? f.start - insertLength : f.start,
        end: f.end > gfpFeature.start ? f.end - insertLength : f.end,
      })),
  });
  await registerEntity(db, actor, pEmpty.id);

  // ---------------------------------------------------------------------------------------
  // The primers used to clone the insert, with their cloning tails

  const forwardAnneal = built.sequence.slice(gfpFeature.start, gfpFeature.start + 22);
  const reverseAnneal = reverseComplement(built.sequence.slice(gfpFeature.end - 22, gfpFeature.end));

  const fwdPrimer = await createEntity(db, actor, {
    name: "GFP-F (EcoRI)",
    folderId: oligos.id,
    schemaId: oligoSchema.id,
    sequence: "aaaGAATTC" + forwardAnneal,
    oligoRole: "primer",
    fields: { purpose: "Amplify GFP with an EcoRI site for cloning" },
  });
  const revPrimer = await createEntity(db, actor, {
    name: "GFP-R (HindIII)",
    folderId: oligos.id,
    schemaId: oligoSchema.id,
    sequence: "aaaAAGCTT" + reverseAnneal,
    oligoRole: "primer",
    fields: { purpose: "Amplify GFP with a HindIII site for cloning" },
  });
  await registerEntity(db, actor, fwdPrimer.id);
  await registerEntity(db, actor, revPrimer.id);

  // The PCR product, recorded as a construct made from the template and both primers.
  await createConstruct(db, actor, {
    name: "GFP amplicon",
    folderId: constructs.id,
    sequence: "aaaGAATTC" + built.sequence.slice(gfpFeature.start, gfpFeature.end) + "AAGCTTttt",
    isCircular: false,
    method: "pcr",
    features: [{ name: "GFP", type: "CDS", strand: 1, segments: [{ start: 9, end: 9 + insertLength }] }],
    parents: [
      { entityId: pGFP.id, role: "template" },
      { entityId: fwdPrimer.id, role: "forward primer" },
      { entityId: revPrimer.id, role: "reverse primer" },
    ],
    details: { annealingTemp: 62, note: "Seeded example of a recorded PCR" },
  });

  // ---------------------------------------------------------------------------------------
  // Strains

  const gfpStrain = await createEntity(db, actor, {
    name: "BL21 + pGFP-tac",
    folderId: strains.id,
    schemaId: strainSchema.id,
    fields: {
      host: opt(host, "E. coli"),
      plasmids: [pGFP.id],
      genotype: "F– ompT hsdSB(rB–, mB–) gal dcm (DE3)",
      received_on: "2026-10-01",
    },
  });
  const controlStrain = await createEntity(db, actor, {
    name: "BL21 + pEmpty-tac",
    folderId: strains.id,
    schemaId: strainSchema.id,
    fields: { host: opt(host, "E. coli"), plasmids: [pEmpty.id], genotype: "F– ompT hsdSB(rB–, mB–) gal dcm (DE3)" },
  });
  await registerEntity(db, actor, gfpStrain.id);
  await registerEntity(db, actor, controlStrain.id);
  await createEntity(db, actor, { name: "GFP (protein)", folderId: root.id, entityType: "aa_sequence", sequence: GFP_PROTEIN });

  // ---------------------------------------------------------------------------------------
  // Sequencing verification: two reads, one of which carries a point mutation

  const readWindow = (start: number, length: number) => {
    const bases = built.sequence.slice(start, start + length);
    // Sanger traces are poor at both ends and good in the middle.
    const qualities = bases.split("").map((_, i) => (i < 30 || i > bases.length - 30 ? 11 : 52));
    return { bases, qualities };
  };

  const forwardRead = readWindow(gfpFeature.start - 120, 760);
  // A real nonsense mutation: codon 13 of the coding sequence (CAG, Gln) becomes TAG, a stop.
  const mutationOffset = gfpFeature.start + 12 * 3 - (gfpFeature.start - 120);
  const mutatedBases = forwardRead.bases.slice(0, mutationOffset) + "T" + forwardRead.bases.slice(mutationOffset + 1);
  const reverseRead = readWindow(gfpFeature.start + 350, 700);

  await createAlignment(db, actor, {
    name: "pGFP-tac colony 3 — Sanger",
    referenceEntityId: pGFP.id,
    folderId: constructs.id,
    reads: [
      { name: "colony3-T7F.ab1", sequence: mutatedBases, qualities: forwardRead.qualities },
      {
        name: "colony3-T7R.ab1",
        sequence: reverseComplement(reverseRead.bases),
        qualities: [...reverseRead.qualities].reverse(),
      },
    ],
  });

  // ---------------------------------------------------------------------------------------
  // Notebook entry with results

  const mention = (entity: { id: string; name: string }, registryId: string) => ({
    type: "entityMention",
    attrs: { id: entity.id, label: `${entity.name} (${registryId})` },
  });
  const entry = await createEntry(db, actor, {
    name: "2026-10-17 IPTG induction curve",
    folderId: notebook.id,
    content: {
      type: "doc",
      content: [
        { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "Aim" }] },
        {
          type: "paragraph",
          content: [
            { type: "text", text: "Measure GFP fluorescence of " },
            mention(gfpStrain, "STR-001"),
            { type: "text", text: " against the empty-vector control " },
            mention(controlStrain, "STR-002"),
            { type: "text", text: " across IPTG concentrations." },
          ],
        },
        { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "Method" }] },
        {
          type: "orderedList",
          content: [
            "Overnight cultures in LB + ampicillin (100 µg/mL), 37 °C.",
            "Dilute 1:100, grow to OD600 ≈ 0.5, induce with IPTG.",
            "Express 4 h at 30 °C; read OD600 and fluorescence (ex 485 / em 510).",
          ].map((text) => ({ type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text }] }] })),
        },
        { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "Results" }] },
        { type: "resultsTable", attrs: { schemaId: assaySchema.id } },
        {
          type: "paragraph",
          content: [{ type: "text", text: "Fluorescence saturates above 0.5 mM IPTG; the empty vector stays at background." }],
        },
      ],
    },
  });
  await createResults(db, actor, {
    schemaId: assaySchema.id,
    entryId: entry.id,
    rows: [
      ...[0, 0.05, 0.1, 0.5, 1].map((iptg, i) => ({
        sample: gfpStrain.id,
        induction_mm: iptg,
        od600: [1.92, 1.88, 1.85, 1.79, 1.76][i],
        fluorescence_rfu: [310, 4200, 9800, 21400, 22100][i],
      })),
      { sample: controlStrain.id, induction_mm: 1, od600: 1.95, fluorescence_rfu: 295 },
    ],
  });

  console.log(
    `Seeded "${DEMO_PROJECT}" (${project.id}): ${built.sequence.length} bp plasmid, primers, sequencing run and notebook entry.`,
  );
  console.log(`Sign in as "dev" with the password "${password}".`);
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(e);
    process.exit(1);
  },
);
