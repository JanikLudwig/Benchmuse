import { beforeAll, describe, expect, it } from "vitest";
import { createPgliteDb, type Db } from "../db/client";
import { newId } from "../domain/ids";
import { setArchived } from "./archive";
import { listAudit, type Actor } from "./audit";
import { createEntity, getEntity, moveEntity, registerEntity, updateEntity } from "./entities";
import { createEntry, createResults, listResults, mentionedEntityIds, updateEntry } from "./entries";
import { ConflictError, ValidationError } from "./errors";
import { createFolder, createProject, getProjectRootFolder, listFolderContents, moveFolder } from "./projects";
import { addDropdownOption, addSchemaField, createDropdown, createSchema, updateSchema, updateSchemaField } from "./schemas";
import { search } from "./search";
import { ensureUser } from "./users";

let db: Db;
let actor: Actor;

beforeAll(async () => {
  db = await createPgliteDb(); // in-memory, migrated
  actor = await ensureUser(db, { handle: "ada", name: "Ada Lovelace", email: "ada@example.com" });
});

async function newProject(name = "Strain engineering") {
  const project = await createProject(db, actor, { name });
  const root = await getProjectRootFolder(db, project.id);
  return { project, root };
}

describe("projects and folders", () => {
  it("creates a project with a root folder and nests folders", async () => {
    const { project, root } = await newProject();
    expect(root.name).toBe(project.name);
    const a = await createFolder(db, actor, { name: "Plasmids", projectId: project.id });
    const b = await createFolder(db, actor, { name: "Backbones", parentFolderId: a.id });
    expect(a.parentFolderId).toBe(root.id);
    expect((await listFolderContents(db, a.id)).folders.map((f) => f.id)).toEqual([b.id]);
  });

  it("refuses to move a folder into its own subtree or to another project", async () => {
    const { project } = await newProject("Move tests");
    const a = await createFolder(db, actor, { name: "A", projectId: project.id });
    const b = await createFolder(db, actor, { name: "B", parentFolderId: a.id });
    await expect(moveFolder(db, actor, a.id, b.id)).rejects.toThrow(/itself or its descendants/);
    const other = await newProject("Other");
    await expect(moveFolder(db, actor, b.id, other.root.id)).rejects.toThrow(/another project/);
  });

  it("does not allow archiving a root folder", async () => {
    const { root } = await newProject("Root archive");
    await expect(setArchived(db, actor, [root.id], "other")).rejects.toThrow(/root folder/);
  });
});

describe("schemas, registration and audit", () => {
  it("runs the plasmid lifecycle: schema -> create -> validate -> register -> audit", async () => {
    const { root } = await newProject("Registry");
    const resistance = await createDropdown(db, actor, { name: "Antibiotic", options: ["Ampicillin", "Kanamycin"] });
    const backbone = await createSchema(db, actor, { kind: "entity", name: "Backbone", entityType: "dna_sequence", nameTemplate: "BB-{n:3}" });
    const plasmid = await createSchema(db, actor, {
      kind: "entity",
      name: "Plasmid",
      entityType: "dna_sequence",
      nameTemplate: "PLS-{n:4}",
      fields: [
        { name: "resistance", displayName: "Resistance", type: "dropdown", dropdownId: resistance.id, isRequired: true },
        { name: "backbone", displayName: "Backbone", type: "entity_link", targetSchemaId: backbone.id },
        { name: "copy_number", displayName: "Copy number", type: "integer" },
      ],
    });

    const pUC = await createEntity(db, actor, { name: "pUC19 backbone", folderId: root.id, schemaId: backbone.id, sequence: "ATGC" });
    const amp = resistance.options[0]!;

    await expect(
      createEntity(db, actor, { name: "bad", folderId: root.id, schemaId: plasmid.id, sequence: "ATGX", fields: { resistance: amp.id } }),
    ).rejects.toThrow(/invalid nucleotide character 'X'/);
    await expect(
      createEntity(db, actor, { name: "bad", folderId: root.id, schemaId: plasmid.id, sequence: "ATG", fields: {} }),
    ).rejects.toMatchObject({ fieldErrors: [{ field: "resistance", message: "is required" }] });
    await expect(
      createEntity(db, actor, {
        name: "bad",
        folderId: root.id,
        schemaId: plasmid.id,
        sequence: "ATG",
        fields: { resistance: amp.id, backbone: newId("entity") },
      }),
    ).rejects.toMatchObject({ fieldErrors: [{ field: "backbone", message: expect.stringContaining("not found") }] });

    const p1 = await createEntity(db, actor, {
      name: "pAB001",
      folderId: root.id,
      schemaId: plasmid.id,
      sequence: "atgaaaGGGtaa ttt\n123",
      isCircular: true,
      fields: { resistance: amp.id, backbone: pUC.id, copy_number: "500" },
      features: [{ name: "CDS", start: 0, end: 12, type: "CDS" }, { name: "wrap", start: 12, end: 3 }],
    });
    expect(p1.sequence).toBe("atgaaaGGGtaattt");
    expect(p1.fields).toEqual({ resistance: amp.id, backbone: pUC.id, copy_number: 500 });
    expect(p1.features.map((f) => f.id)).toEqual([expect.stringMatching(/^ann_/), expect.stringMatching(/^ann_/)]);
    expect(p1.features[1]!.segments).toEqual([{ start: 12, end: 3 }]);

    const r1 = await registerEntity(db, actor, p1.id);
    expect(r1.registryId).toBe("PLS-0001");
    await expect(registerEntity(db, actor, p1.id)).rejects.toBeInstanceOf(ConflictError);
    await expect(updateEntity(db, actor, p1.id, { sequence: "ATG" })).rejects.toThrow(/immutable/);

    const p2 = await createEntity(db, actor, { name: "pAB002", folderId: root.id, schemaId: plasmid.id, sequence: "AT", fields: { resistance: amp.id } });
    expect((await registerEntity(db, actor, p2.id)).registryId).toBe("PLS-0002");

    // Changing the template to collide with an existing ID skips the taken number.
    await updateSchema(db, actor, plasmid.id, { nameTemplate: "PLS-{n:4}" });
    const updated = await updateEntity(db, actor, p1.id, { fields: { copy_number: 20 }, name: "pAB001 v2" });
    expect(updated.fields.copy_number).toBe(20);

    const audit = await listAudit(db, p1.id);
    expect(audit.map((a) => a.action)).toEqual(["update", "register", "create"]);
    expect(audit[0]!.changes).toEqual({
      name: { from: "pAB001", to: "pAB001 v2" },
      "fields.copy_number": { from: 500, to: 20 },
    });
  });

  it("rejects archived dropdown options and wrong-schema links, and enforces new required fields at registration", async () => {
    const { root } = await newProject("Strict");
    const dd = await createDropdown(db, actor, { name: "Host", options: ["E. coli"] });
    const yeast = await addDropdownOption(db, actor, dd.id, "S. cerevisiae");
    const strain = await createSchema(db, actor, { kind: "entity", name: "Strain", entityType: "custom", nameTemplate: "STR{n}" });
    const other = await createSchema(db, actor, { kind: "entity", name: "Other", entityType: "custom" });
    await addSchemaField(db, actor, strain.id, { name: "host", displayName: "Host", type: "dropdown", dropdownId: dd.id });
    const parentField = await addSchemaField(db, actor, strain.id, { name: "parent", displayName: "Parent", type: "entity_link", targetSchemaId: strain.id });

    const o = await createEntity(db, actor, { name: "o", folderId: root.id, schemaId: other.id });
    await expect(
      createEntity(db, actor, { name: "s", folderId: root.id, schemaId: strain.id, fields: { parent: o.id } }),
    ).rejects.toMatchObject({ fieldErrors: [{ field: "parent", message: expect.stringContaining("wrong schema") }] });

    const s = await createEntity(db, actor, { name: "s", folderId: root.id, schemaId: strain.id, fields: { host: yeast.id } });
    await updateSchemaField(db, actor, strain.id, parentField.id, { isRequired: true });
    await expect(registerEntity(db, actor, s.id)).rejects.toMatchObject({ fieldErrors: [{ field: "parent", message: "is required" }] });

    await expect(addSchemaField(db, actor, strain.id, { name: "host", displayName: "Dup", type: "text" })).rejects.toBeInstanceOf(ValidationError);
    await expect(createSchema(db, actor, { kind: "entity", name: "Strain", entityType: "custom" })).rejects.toBeInstanceOf(ConflictError);
    await expect(createSchema(db, actor, { kind: "result", name: "R", nameTemplate: "R{n}" })).rejects.toThrow(/Only entity schemas/);
  });

  it("serializes concurrent registrations into distinct IDs", async () => {
    const { root } = await newProject("Concurrency");
    const schema = await createSchema(db, actor, { kind: "entity", name: "Oligo batch", entityType: "dna_sequence", nameTemplate: "OL{n:3}" });
    const made = await Promise.all(
      Array.from({ length: 8 }, (_, i) => createEntity(db, actor, { name: `oligo ${i}`, folderId: root.id, schemaId: schema.id, sequence: "ACGT" })),
    );
    const registered = await Promise.all(made.map((e) => registerEntity(db, actor, e.id)));
    expect(registered.map((r) => r.registryId).sort()).toEqual(["OL001", "OL002", "OL003", "OL004", "OL005", "OL006", "OL007", "OL008"]);
  });
});

describe("notebook entries and results", () => {
  it("stores documents, tracks mentions, and captures validated result rows", async () => {
    const { root } = await newProject("Notebook");
    const sample = await createEntity(db, actor, { name: "GFP", folderId: root.id, entityType: "aa_sequence", sequence: "MSKGEELFT" });
    const assay = await createSchema(db, actor, {
      kind: "result",
      name: "Plate reader",
      fields: [
        { name: "sample", displayName: "Sample", type: "entity_link", isRequired: true },
        { name: "fluorescence", displayName: "Fluorescence (RFU)", type: "float", isRequired: true },
      ],
    });
    const content = {
      type: "doc",
      content: [{ type: "paragraph", content: [{ type: "text", text: "Measured " }, { type: "entityMention", attrs: { id: sample.id } }] }],
    };
    const entry = await createEntry(db, actor, { name: "2026-10-17 GFP expression", folderId: root.id, content });
    expect(mentionedEntityIds(entry.content)).toEqual([sample.id]);
    await expect(updateEntry(db, actor, entry.id, { content: { type: "paragraph" } })).rejects.toThrow(/must be a document/);

    await expect(
      createResults(db, actor, { schemaId: assay.id, entryId: entry.id, rows: [{ sample: sample.id, fluorescence: 1 }, { sample: sample.id }] }),
    ).rejects.toMatchObject({ fieldErrors: [{ field: "rows[1].fluorescence", message: "is required" }] });
    const rows = await createResults(db, actor, {
      schemaId: assay.id,
      entryId: entry.id,
      rows: [{ sample: sample.id, fluorescence: 1520.5 }, { sample: sample.id, fluorescence: "1610" }],
    });
    expect(rows).toHaveLength(2);
    expect((await listResults(db, { entryId: entry.id })).map((r) => r.fields.fluorescence)).toEqual([1520.5, 1610]);

    // Repeated autosaves within one editing session produce a single audit event.
    const doc = (text: string) => ({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text }] }] });
    await updateEntry(db, actor, entry.id, { content: doc("a") });
    await updateEntry(db, actor, entry.id, { content: doc("ab") });
    await updateEntry(db, actor, entry.id, { content: doc("abc") });
    await updateEntry(db, actor, entry.id, { name: "renamed" });
    await updateEntry(db, actor, entry.id, { content: doc("abcd") });
    expect((await listAudit(db, entry.id)).map((a) => Object.keys(a.changes).join())).toEqual(["content", "name", "content", "name"]);

    await setArchived(db, actor, [entry.id], "made_in_error");
    await expect(updateEntry(db, actor, entry.id, { name: "x" })).rejects.toThrow(/Archived entries/);
  });
});

describe("search", () => {
  it("filters by type, schema, folder, fields, registration and free text, with paging", async () => {
    const { project, root } = await newProject("Searchable");
    const sub = await createFolder(db, actor, { name: "Primers", projectId: project.id });
    const schema = await createSchema(db, actor, {
      kind: "entity",
      name: "Primer",
      entityType: "dna_sequence",
      nameTemplate: "PR{n:2}",
      fields: [
        { name: "tm", displayName: "Tm", type: "float" },
        { name: "tags", displayName: "Tags", type: "text", isMulti: true },
      ],
    });
    const mk = (name: string, fields: Record<string, unknown>, folderId = sub.id) =>
      createEntity(db, actor, { name, folderId, schemaId: schema.id, sequence: "ACGT", fields, aliases: [`${name}-alias`] });
    const fwd = await mk("fwd_gfp", { tm: 58.2, tags: ["gfp", "cloning"] });
    const rev = await mk("rev_gfp", { tm: 61.0, tags: ["gfp"] });
    const other = await mk("seq_lacZ", { tm: 54 }, root.id);
    await registerEntity(db, actor, fwd.id);
    await createEntry(db, actor, { name: "gfp cloning notes", folderId: sub.id });

    const ids = async (params: Parameters<typeof search>[1]) => (await search(db, params)).items.map((i) => i.id);
    const inProject = `project:EQ:${project.id}`;

    expect(await ids({ filter: `${inProject};type:EQ:entity`, sort: "name:asc" })).toEqual([fwd.id, rev.id, other.id]);
    expect(await ids({ filter: `${inProject};folder:EQ:${sub.id};type:EQ:entity`, sort: "name:asc" })).toEqual([fwd.id, rev.id]);
    expect(await ids({ filter: `${inProject};field.tm:GTE:58`, sort: "name:asc" })).toEqual([fwd.id, rev.id]);
    expect(await ids({ filter: `${inProject};field.tags:EQ:cloning` })).toEqual([fwd.id]);
    expect(await ids({ filter: `${inProject};field.tags:IS_EMPTY;type:EQ:entity` })).toEqual([other.id]);
    expect(await ids({ filter: `${inProject};registered:IS_TRUE` })).toEqual([fwd.id]);
    expect(await ids({ filter: inProject, q: "PR01" })).toEqual([fwd.id]);
    expect(await ids({ filter: inProject, q: "rev_gfp-alias" })).toEqual([rev.id]);
    expect((await search(db, { filter: inProject, q: "gfp" })).items.map((i) => i.type).sort()).toEqual(["entity", "entity", "entry"]);
    expect((await search(db, { filter: `${inProject};type:EQ:folder` })).items.map((i) => i.name)).toEqual(["Primers"]);

    const page1 = await search(db, { filter: `${inProject};type:EQ:entity`, sort: "name:asc", limit: 2 });
    const page2 = await search(db, { filter: `${inProject};type:EQ:entity`, sort: "name:asc", limit: 2, offset: 2 });
    expect(page1.total).toBe(3);
    expect([...page1.items, ...page2.items].map((i) => i.id)).toEqual([fwd.id, rev.id, other.id]);

    await setArchived(db, actor, [rev.id], "retired");
    expect(await ids({ filter: `${inProject};type:EQ:entity`, sort: "name:asc" })).toEqual([fwd.id, other.id]);
    expect(await ids({ filter: `${inProject};archived:IS_TRUE` })).toEqual([rev.id]);

    await moveEntity(db, actor, other.id, sub.id);
    expect((await getEntity(db, other.id)).folderId).toBe(sub.id);

    await expect(search(db, { filter: "nonsense:EQ:x" })).rejects.toThrow(/unknown property/);
    await expect(search(db, { filter: "type:EQ:robot" })).rejects.toThrow(/type must be one of/);
    await expect(search(db, { sort: "sequence:asc" })).rejects.toThrow(/Cannot sort/);
  });

  it("treats injection attempts in filter values as plain data", async () => {
    const res = await search(db, { filter: "name:EQ:x'%20or%201%3D1%3B--;field.a'b:EQ:1".replace("field.a'b", "field.ab") });
    expect(res.items).toEqual([]);
  });
});
