import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createPgliteDb, type Db } from "../db/client";
import type { Actor } from "./audit";
import { setArchived } from "./archive";
import { createEntry, referencedFileIds, referencedTableIds, updateEntry } from "./entries";
import { createFolder, createProject, getProjectRootFolder } from "./projects";
import {
  createTable,
  deleteTable,
  getEvaluatedTable,
  listTablesForEntry,
  MAX_COLUMNS,
  MAX_ROWS,
  ORPHAN_GRACE_MS,
  parseDelimited,
  pruneOrphanTables,
  tableToCsv,
  updateTable,
} from "./notebookTables";
import { ensureUser } from "./users";

let db: Db;
let actor: Actor;
let entryId: string;

beforeAll(async () => {
  db = await createPgliteDb();
  actor = await ensureUser(db, { handle: "eln", name: "ELN Tester", email: "eln@example.com" });
});

beforeEach(async () => {
  const project = await createProject(db, actor, { name: `Project ${Math.random().toString(36).slice(2, 8)}` });
  const folder = await getProjectRootFolder(db, project.id);
  const entry = await createEntry(db, actor, { name: "Experiment", folderId: folder.id });
  entryId = entry.id;
});

const docWithTables = (...tableIds: string[]) => ({
  type: "doc",
  content: [
    { type: "paragraph", content: [{ type: "text", text: "Setup" }] },
    ...tableIds.map((tableId) => ({ type: "dataTable", attrs: { tableId } })),
  ],
});

describe("creating and reading tables", () => {
  it("starts with usable columns and blank rows", async () => {
    const table = await createTable(db, actor, { entryId });
    expect(table.columns).toHaveLength(3);
    expect(table.rows).toHaveLength(5);
    // Every row is padded to the column count, so the grid is never ragged.
    expect(table.rows.every((row) => row.length === table.columns.length)).toBe(true);
  });

  it("gives every column an id, even when the caller omits one", async () => {
    const table = await createTable(db, actor, {
      entryId,
      columns: [{ name: "Sample" }, { name: "A260" }, { name: "A280" }],
    });
    const ids = table.columns.map((c) => c.id);
    expect(new Set(ids).size).toBe(3);
    expect(ids.every(Boolean)).toBe(true);
  });

  it("does not let two columns share an id", async () => {
    const table = await createTable(db, actor, {
      entryId,
      columns: [
        { id: "same", name: "First" },
        { id: "same", name: "Second" },
      ],
    });
    expect(table.columns[0]!.id).not.toBe(table.columns[1]!.id);
  });

  it("evaluates formulas on read rather than storing their results", async () => {
    const table = await createTable(db, actor, {
      entryId,
      columns: [{ name: "Replicate", type: "number" }, { name: "Doubled", type: "number" }],
      rows: [
        ["4", "=A1*2"],
        ["6", "=A2*2"],
        ["", "=SUM(A1:A2)"],
      ],
    });
    const read = await getEvaluatedTable(db, table.id);
    expect(read.values[0]![1]!.value).toBe(8);
    expect(read.values[1]![1]!.value).toBe(12);
    expect(read.values[2]![1]!.value).toBe(10);
    // The stored cell is still the formula, not the number it worked out to.
    expect(read.rows[0]![1]).toBe("=A1*2");
  });

  it("recomputes after an edit without the formula being rewritten", async () => {
    const table = await createTable(db, actor, {
      entryId,
      columns: [{ name: "Conc", type: "number" }, { name: "Half", type: "number" }],
      rows: [["100", "=A1/2"]],
    });
    const updated = await updateTable(db, actor, table.id, { rows: [["250", "=A1/2"]] });
    expect(updated.values[0]![1]!.value).toBe(125);
  });
});

describe("limits and validation", () => {
  it("refuses more rows than the limit", async () => {
    const table = await createTable(db, actor, { entryId, columns: [{ name: "X" }] });
    const rows = Array.from({ length: MAX_ROWS + 1 }, () => ["1"]);
    await expect(updateTable(db, actor, table.id, { rows })).rejects.toThrow(/at most/);
  });

  it("refuses more columns than the limit", async () => {
    const columns = Array.from({ length: MAX_COLUMNS + 1 }, (_, i) => ({ name: `C${i}` }));
    await expect(createTable(db, actor, { entryId, columns })).rejects.toThrow(/at most/);
  });

  it("rejects an unknown column type", async () => {
    await expect(
      // deliberately outside the union, as an API caller could send
      createTable(db, actor, { entryId, columns: [{ name: "X", type: "protein" as never }] }),
    ).rejects.toThrow(/Unknown column type/);
  });

  it("pads short rows and trims long ones to the column count", async () => {
    const table = await createTable(db, actor, {
      entryId,
      columns: [{ name: "A" }, { name: "B" }],
      rows: [["1"], ["1", "2", "3"]],
    });
    expect(table.rows[0]).toEqual(["1", ""]);
    expect(table.rows[1]).toEqual(["1", "2"]);
  });

  it("keeps the grid rectangular when a column is removed", async () => {
    const table = await createTable(db, actor, {
      entryId,
      columns: [{ name: "A" }, { name: "B" }, { name: "C" }],
      rows: [["1", "2", "3"]],
    });
    // Only the columns change; the stored rows must follow.
    const updated = await updateTable(db, actor, table.id, { columns: [{ name: "A" }, { name: "B" }] });
    expect(updated.rows[0]).toEqual(["1", "2"]);
  });

  it("will not write to an archived entry", async () => {
    const table = await createTable(db, actor, { entryId });
    await setArchived(db, actor, [entryId], "made_in_error");
    await expect(updateTable(db, actor, table.id, { rows: [["1"]] })).rejects.toThrow(/Archived/);
    await expect(createTable(db, actor, { entryId })).rejects.toThrow(/Archived/);
  });

  it("will not attach a table to an entry that does not exist", async () => {
    await expect(createTable(db, actor, { entryId: "entry_000000000000" })).rejects.toThrow(/not found|Entry/i);
  });
});

describe("CSV export", () => {
  it("exports computed values, with units in the header", async () => {
    const table = await createTable(db, actor, {
      entryId,
      name: "Master mix",
      columns: [
        { name: "Component", type: "text" },
        { name: "Volume", type: "number", unit: "µL" },
        { name: "Total", type: "number", unit: "µL" },
      ],
      rows: [
        ["Buffer", "5", "=B1*4"],
        ["Primer F", "1.25", "=B2*4"],
      ],
    });
    const csv = tableToCsv(await getEvaluatedTable(db, table.id));
    const lines = csv.trim().split("\n");
    expect(lines[0]).toBe("Component,Volume (µL),Total (µL)");
    // The formula is gone; whoever opens this gets numbers.
    expect(lines[1]).toBe("Buffer,5,20");
    expect(lines[2]).toBe("Primer F,1.25,5");
  });

  it("quotes values that would otherwise break the row", async () => {
    const table = await createTable(db, actor, {
      entryId,
      columns: [{ name: "Note", type: "text" }],
      rows: [['He said "stop", loudly'], ["two\nlines"]],
    });
    const csv = tableToCsv(await getEvaluatedTable(db, table.id));
    expect(csv).toContain('"He said ""stop"", loudly"');
    expect(csv).toContain('"two\nlines"');
  });
});

describe("parsing a pasted grid", () => {
  it("reads tab-separated text, as copying out of Excel produces", () => {
    expect(parseDelimited("a\tb\tc\n1\t2\t3\n")).toEqual([
      ["a", "b", "c"],
      ["1", "2", "3"],
    ]);
  });

  it("reads quoted CSV, keeping commas inside the quotes", () => {
    expect(parseDelimited('name,note\nTube 1,"cloudy, discard"')).toEqual([
      ["name", "note"],
      ["Tube 1", "cloudy, discard"],
    ]);
  });

  it("handles Windows line endings without leaving stray carriage returns", () => {
    expect(parseDelimited("a\tb\r\n1\t2\r\n")).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
  });

  it("keeps empty trailing cells, which carry meaning in a grid", () => {
    expect(parseDelimited("1\t\t3")).toEqual([["1", "", "3"]]);
  });
});

describe("tables and the document that holds them", () => {
  it("finds the tables and files a document refers to", () => {
    const doc = {
      type: "doc",
      content: [
        { type: "dataTable", attrs: { tableId: "table_a" } },
        { type: "labImage", attrs: { fileId: "file_a" } },
        { type: "paragraph", content: [{ type: "attachment", attrs: { fileId: "file_b" } }] },
      ],
    };
    expect(referencedTableIds(doc)).toEqual(["table_a"]);
    expect(referencedFileIds(doc).sort()).toEqual(["file_a", "file_b"]);
  });

  it("lists an entry's tables oldest first", async () => {
    const first = await createTable(db, actor, { entryId, name: "First" });
    const second = await createTable(db, actor, { entryId, name: "Second" });
    const listed = await listTablesForEntry(db, entryId);
    expect(listed.map((t) => t.id)).toEqual([first.id, second.id]);
  });

  /**
   * The grace period exists so that deleting a table block and pressing Ctrl+Z does not lose
   * the data: autosave runs in between, and an eager prune would have already dropped the rows.
   */
  it("keeps a freshly orphaned table so an undo can still find its data", async () => {
    const table = await createTable(db, actor, { entryId, rows: [["precious"]] });
    await updateEntry(db, actor, entryId, { content: docWithTables() });
    const stillThere = await getEvaluatedTable(db, table.id);
    expect(stillThere.rows[0]![0]).toBe("precious");
  });

  it("removes an orphan once it is past the grace period", async () => {
    const table = await createTable(db, actor, { entryId });
    const later = new Date(Date.now() + ORPHAN_GRACE_MS + 60_000);
    expect(await pruneOrphanTables(db, entryId, [], later)).toBe(1);
    await expect(getEvaluatedTable(db, table.id)).rejects.toThrow(/not found|Table/i);
  });

  it("never removes a table the document still refers to, however old", async () => {
    const kept = await createTable(db, actor, { entryId });
    const dropped = await createTable(db, actor, { entryId });
    const later = new Date(Date.now() + ORPHAN_GRACE_MS * 10);
    expect(await pruneOrphanTables(db, entryId, [kept.id], later)).toBe(1);
    expect((await getEvaluatedTable(db, kept.id)).id).toBe(kept.id);
    await expect(getEvaluatedTable(db, dropped.id)).rejects.toThrow();
  });

  it("deletes a table on request", async () => {
    const table = await createTable(db, actor, { entryId });
    await deleteTable(db, actor, table.id);
    await expect(getEvaluatedTable(db, table.id)).rejects.toThrow();
  });
});
