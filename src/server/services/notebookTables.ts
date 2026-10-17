/**
 * Spreadsheet tables embedded in notebook entries.
 *
 * The service stores raw cell text and never computed values, so a table always shows what the
 * formulas currently mean rather than a stale snapshot. Evaluation happens on read, using the
 * same engine the editor uses, so the server and the browser never disagree.
 */

import { and, asc, eq, inArray } from "drizzle-orm";
import { evaluateGrid, toText, type EvaluatedCell } from "@/lib/formula/evaluate";
import type { Db } from "../db/client";
import { entries, notebookTables, TABLE_COLUMN_TYPES, type TableColumn, type TableColumnType } from "../db/schema";
import { newId } from "../domain/ids";
import { recordAudit, type Actor } from "./audit";
import { NotFoundError, ValidationError } from "./errors";

export const MAX_ROWS = 2000;
export const MAX_COLUMNS = 60;
const MAX_CELL_LENGTH = 10_000;

/**
 * Check the entry exists and can be written to.
 *
 * Queried directly rather than through the entries service, because that service prunes orphan
 * tables through this module and importing it back would make the two files circular.
 */
async function requireWritableEntry(db: Db, entryId: string): Promise<void> {
  const [entry] = await db.select({ archivedAt: entries.archivedAt }).from(entries).where(eq(entries.id, entryId));
  if (!entry) throw new NotFoundError("Entry", entryId);
  if (entry.archivedAt) throw new ValidationError("Archived entries cannot be edited");
}

export interface ColumnInput {
  id?: string;
  name: string;
  type?: TableColumnType;
  unit?: string;
  width?: number;
  options?: string[];
  decimals?: number;
}

function normalizeColumns(input: readonly ColumnInput[]): TableColumn[] {
  if (input.length > MAX_COLUMNS) throw new ValidationError(`A table can have at most ${MAX_COLUMNS} columns`);
  const seen = new Set<string>();
  return input.map((column, index) => {
    const type = column.type ?? "text";
    if (!TABLE_COLUMN_TYPES.includes(type)) throw new ValidationError(`Unknown column type '${type}'`);
    let id = column.id && !seen.has(column.id) ? column.id : newId("column");
    seen.add(id);
    return {
      id,
      name: (column.name?.trim() || `Column ${index + 1}`).slice(0, 100),
      type,
      ...(column.unit?.trim() ? { unit: column.unit.trim().slice(0, 20) } : {}),
      ...(column.width ? { width: Math.max(60, Math.min(600, Math.round(column.width))) } : {}),
      ...(column.options?.length ? { options: column.options.slice(0, 100).map((o) => o.slice(0, 100)) } : {}),
      ...(column.decimals !== undefined ? { decimals: Math.max(0, Math.min(10, Math.round(column.decimals))) } : {}),
    };
  });
}

function normalizeRows(rows: readonly (readonly (string | null | undefined)[])[], width: number): string[][] {
  if (rows.length > MAX_ROWS) throw new ValidationError(`A table can have at most ${MAX_ROWS.toLocaleString("en")} rows`);
  return rows.map((row) =>
    Array.from({ length: width }, (_, i) => {
      const cell = row[i];
      if (cell === null || cell === undefined) return "";
      const text = String(cell);
      if (text.length > MAX_CELL_LENGTH) throw new ValidationError("A cell holds more text than a table cell should");
      return text;
    }),
  );
}

/** A starter grid: a few named columns and blank rows, so a new table is usable immediately. */
const DEFAULT_COLUMNS: ColumnInput[] = [
  { name: "Sample", type: "text" },
  { name: "Value", type: "number" },
  { name: "Notes", type: "text" },
];

export interface CreateTableInput {
  entryId: string;
  name?: string;
  columns?: ColumnInput[];
  rows?: string[][];
}

export async function createTable(db: Db, actor: Actor, input: CreateTableInput) {
  await requireWritableEntry(db, input.entryId);

  const columns = normalizeColumns(input.columns?.length ? input.columns : DEFAULT_COLUMNS);
  const rows = input.rows?.length ? normalizeRows(input.rows, columns.length) : blankRows(5, columns.length);

  return db.transaction(async (tx) => {
    const [table] = await tx
      .insert(notebookTables)
      .values({
        id: newId("table"),
        entryId: input.entryId,
        name: input.name?.trim().slice(0, 200) || "Table",
        columns,
        rows,
        createdById: actor.id,
      })
      .returning();
    await recordAudit(tx, actor, table!.id, "create", { name: { from: null, to: table!.name } });
    return table!;
  });
}

const blankRows = (count: number, width: number): string[][] =>
  Array.from({ length: count }, () => Array.from({ length: width }, () => ""));

export async function getTable(db: Db, id: string) {
  const [table] = await db.select().from(notebookTables).where(eq(notebookTables.id, id));
  if (!table) throw new NotFoundError("Table", id);
  return table;
}

export interface EvaluatedTable {
  id: string;
  entryId: string;
  name: string;
  columns: TableColumn[];
  rows: string[][];
  /** computed values, parallel to `rows` */
  values: EvaluatedCell[][];
  modifiedAt: Date;
}

/** A table with its formulas worked out, ready to render. */
export async function getEvaluatedTable(db: Db, id: string, now = new Date()): Promise<EvaluatedTable> {
  return evaluateTable(await getTable(db, id), now);
}

export function evaluateTable(table: typeof notebookTables.$inferSelect, now = new Date()): EvaluatedTable {
  return {
    id: table.id,
    entryId: table.entryId,
    name: table.name,
    columns: table.columns,
    rows: table.rows,
    values: evaluateGrid(table.rows, { now, columnTypes: table.columns.map((c) => c.type) }),
    modifiedAt: table.modifiedAt,
  };
}

export async function listTablesForEntry(db: Db, entryId: string) {
  const rows = await db
    .select()
    .from(notebookTables)
    .where(eq(notebookTables.entryId, entryId))
    .orderBy(asc(notebookTables.createdAt));
  return rows.map((t) => evaluateTable(t));
}

export interface UpdateTableInput {
  name?: string;
  columns?: ColumnInput[];
  rows?: string[][];
}

/**
 * Replace a table's shape and contents.
 *
 * The whole grid is sent because a spreadsheet edit can touch many cells at once (a paste, a
 * fill, an inserted column), and a single authoritative write avoids the ordering problems a
 * per-cell protocol would bring.
 */
export async function updateTable(db: Db, actor: Actor, id: string, patch: UpdateTableInput) {
  return db.transaction(async (tx) => {
    const before = await getTable(tx, id);
    await requireWritableEntry(tx, before.entryId);

    const columns = patch.columns ? normalizeColumns(patch.columns) : before.columns;
    const rows = patch.rows ? normalizeRows(patch.rows, columns.length) : normalizeRows(before.rows, columns.length);

    const [after] = await tx
      .update(notebookTables)
      .set({
        ...(patch.name !== undefined && { name: patch.name.trim().slice(0, 200) || "Table" }),
        columns,
        rows,
        modifiedAt: new Date(),
      })
      .where(eq(notebookTables.id, id))
      .returning();

    // Tables change on nearly every keystroke; record that it changed, not every cell.
    const changedCells = countChangedCells(before.rows, rows);
    if (changedCells || patch.columns || patch.name !== undefined) {
      await recordAudit(tx, actor, id, "update", {
        ...(changedCells ? { cells: { from: null, to: `${changedCells} changed` } } : {}),
        ...(patch.columns ? { columns: { from: before.columns.length, to: columns.length } } : {}),
        ...(patch.name !== undefined && patch.name !== before.name ? { name: { from: before.name, to: after!.name } } : {}),
      });
    }
    return evaluateTable(after!);
  });
}

function countChangedCells(before: string[][], after: string[][]): number {
  let changed = 0;
  const rows = Math.max(before.length, after.length);
  for (let r = 0; r < rows; r++) {
    const width = Math.max(before[r]?.length ?? 0, after[r]?.length ?? 0);
    for (let c = 0; c < width; c++) {
      if ((before[r]?.[c] ?? "") !== (after[r]?.[c] ?? "")) changed++;
    }
  }
  return changed;
}

export async function deleteTable(db: Db, actor: Actor, id: string): Promise<void> {
  const table = await getTable(db, id);
  await db.delete(notebookTables).where(eq(notebookTables.id, id));
  await recordAudit(db, actor, id, "archive", { name: { from: table.name, to: null } });
}

/**
 * Export a table as CSV, with formulas replaced by their values — which is what someone opening
 * it in Excel or handing it to a statistician actually wants.
 */
export function tableToCsv(table: EvaluatedTable): string {
  const escape = (value: string) => (/[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value);
  const header = table.columns.map((c) => escape(c.unit ? `${c.name} (${c.unit})` : c.name)).join(",");
  const body = table.values.map((row) => row.map((cell) => escape(toText(cell.value))).join(","));
  return [header, ...body].join("\n") + "\n";
}

/** Parse pasted tab- or comma-separated text into a grid, as a spreadsheet paste would. */
export function parseDelimited(text: string): string[][] {
  const rows = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  if (rows[rows.length - 1] === "") rows.pop();
  // Tabs win when present, because that is what copying out of Excel produces.
  const delimiter = rows[0]?.includes("\t") ? "\t" : ",";
  return rows.map((row) => (delimiter === "\t" ? row.split("\t") : splitCsvRow(row)));
}

function splitCsvRow(row: string): string[] {
  const out: string[] = [];
  let current = "";
  let quoted = false;
  for (let i = 0; i < row.length; i++) {
    const ch = row[i]!;
    if (quoted) {
      if (ch === '"') {
        if (row[i + 1] === '"') {
          current += '"';
          i++;
        } else quoted = false;
      } else current += ch;
      continue;
    }
    if (ch === '"') quoted = true;
    else if (ch === ",") {
      out.push(current);
      current = "";
    } else current += ch;
  }
  out.push(current);
  return out;
}

/** Tables referenced by a document, so deleting a node can clean up its table. */
export async function tablesByIds(db: Db, ids: string[]) {
  return ids.length ? db.select().from(notebookTables).where(inArray(notebookTables.id, ids)) : [];
}

/**
 * How long an orphaned table's data is kept after its block leaves the document.
 *
 * Autosave runs while someone is still editing, so a table whose block was just deleted may be
 * about to come back with Ctrl+Z. Deleting the rows immediately would bring the block back empty
 * and lose real measurements, so an orphan is only removed once it has been untouched for long
 * enough that no undo is plausibly still pending.
 */
export const ORPHAN_GRACE_MS = 24 * 60 * 60 * 1000;

/** Remove tables whose node left the document and whose data is past the undo grace period. */
export async function pruneOrphanTables(
  db: Db,
  entryId: string,
  keepIds: readonly string[],
  now = new Date(),
): Promise<number> {
  const existing = await db
    .select({ id: notebookTables.id, modifiedAt: notebookTables.modifiedAt })
    .from(notebookTables)
    .where(eq(notebookTables.entryId, entryId));

  const cutoff = now.getTime() - ORPHAN_GRACE_MS;
  const orphans = existing
    .filter((t) => !keepIds.includes(t.id) && t.modifiedAt.getTime() < cutoff)
    .map((t) => t.id);
  if (!orphans.length) return 0;

  await db.delete(notebookTables).where(and(eq(notebookTables.entryId, entryId), inArray(notebookTables.id, orphans)));
  return orphans.length;
}
