import { and, asc, desc, eq, inArray, isNull } from "drizzle-orm";
import type { Db } from "../db/client";
import { auditEvents, entries, results } from "../db/schema";
import { newId } from "../domain/ids";
import { diff, recordAudit, type Actor } from "./audit";
import { NotFoundError, ValidationError } from "./errors";
import { validateFieldsAgainstSchema } from "./entities";
import { pruneOrphanTables } from "./notebookTables";
import { getWritableFolder, requireName } from "./projects";
import { getSchema } from "./schemas";

const MAX_CONTENT_BYTES = 5_000_000;

type DocNode = { type?: unknown; content?: unknown; attrs?: unknown };

/** Entries store a ProseMirror/Tiptap document. Only the envelope is validated server-side. */
function checkContent(content: unknown): Record<string, unknown> {
  const doc = content as DocNode;
  if (!doc || typeof doc !== "object" || doc.type !== "doc" || (doc.content !== undefined && !Array.isArray(doc.content))) {
    throw new ValidationError("Entry content must be a document: { type: 'doc', content: [...] }");
  }
  if (JSON.stringify(doc).length > MAX_CONTENT_BYTES) throw new ValidationError("Entry content is too large");
  return doc as Record<string, unknown>;
}

/** Collect one attribute from every node of a given type in a document. */
function collectAttr(content: unknown, types: readonly string[], attr: string): string[] {
  const found = new Set<string>();
  const walk = (node: DocNode) => {
    if (typeof node?.type === "string" && types.includes(node.type)) {
      const value = (node.attrs as Record<string, unknown> | undefined)?.[attr];
      if (typeof value === "string" && value) found.add(value);
    }
    if (Array.isArray(node?.content)) node.content.forEach((n) => walk(n as DocNode));
  };
  walk(content as DocNode);
  return [...found];
}

/** IDs of entities mentioned in a document (`entityMention` nodes), for backlinks and validation. */
export function mentionedEntityIds(content: unknown): string[] {
  return collectAttr(content, ["entityMention"], "id");
}

/** Spreadsheets still present in a document, so ones whose block was deleted can be cleaned up. */
export function referencedTableIds(content: unknown): string[] {
  return collectAttr(content, ["dataTable"], "tableId");
}

/** Files a document displays or links to, for usage reporting and delete protection. */
export function referencedFileIds(content: unknown): string[] {
  return collectAttr(content, ["labImage", "attachment"], "fileId");
}

export async function createEntry(
  db: Db,
  actor: Actor,
  input: { name: string; folderId: string; schemaId?: string | null; fields?: Record<string, unknown>; content?: unknown },
) {
  return db.transaction(async (tx) => {
    await getWritableFolder(tx, input.folderId);
    const schema = input.schemaId ? await getSchema(tx, input.schemaId) : null;
    if (schema && schema.kind !== "entry") throw new ValidationError(`Schema ${schema.id} is not an entry schema`);
    const fields = await validateFieldsAgainstSchema(tx, schema, input.fields, "create");
    const [entry] = await tx
      .insert(entries)
      .values({
        id: newId("entry"),
        name: requireName(input.name, "Entry"),
        folderId: input.folderId,
        schemaId: schema?.id ?? null,
        fields,
        content: input.content === undefined ? { type: "doc", content: [{ type: "paragraph" }] } : checkContent(input.content),
        createdById: actor.id,
      })
      .returning();
    await recordAudit(tx, actor, entry!.id, "create", { name: { from: null, to: entry!.name } });
    return entry!;
  });
}

export async function getEntry(db: Db, id: string) {
  const [entry] = await db.select().from(entries).where(eq(entries.id, id));
  if (!entry) throw new NotFoundError("Entry", id);
  return entry;
}

export async function updateEntry(
  db: Db,
  actor: Actor,
  id: string,
  patch: { name?: string; fields?: Record<string, unknown>; content?: unknown },
) {
  return db.transaction(async (tx) => {
    const before = await getEntry(tx, id);
    if (before.archivedAt) throw new ValidationError("Archived entries cannot be edited; unarchive first");
    const schema = before.schemaId ? await getSchema(tx, before.schemaId) : null;
    const fieldPatch = patch.fields ? await validateFieldsAgainstSchema(tx, schema, patch.fields, "update") : {};
    const [after] = await tx
      .update(entries)
      .set({
        ...(patch.name !== undefined && { name: requireName(patch.name, "Entry") }),
        ...(patch.content !== undefined && { content: checkContent(patch.content) }),
        fields: { ...before.fields, ...fieldPatch },
        modifiedAt: new Date(),
      })
      .where(eq(entries.id, id))
      .returning();
    // Document bodies change on every keystroke-save; audit that they changed, not the full before/after.
    const changes = diff(before, after!, ["name", "fields"]);
    if (patch.content !== undefined && JSON.stringify(before.content) !== JSON.stringify(after!.content)) {
      changes.content = { from: "(previous version)", to: "(edited)" };
    }
    if (Object.keys(changes).length && !(await isContinuingEditSession(tx, actor, id, changes))) {
      await recordAudit(tx, actor, id, "update", changes);
    }
    // A spreadsheet whose block was deleted from the document has nothing left pointing at it.
    // Pruning is deliberately not immediate: see ORPHAN_GRACE_MS.
    if (patch.content !== undefined) {
      await pruneOrphanTables(tx, id, referencedTableIds(after!.content));
    }
    return after!;
  });
}

const EDIT_SESSION_MS = 10 * 60 * 1000;

/**
 * Autosave PATCHes the document every few seconds while someone types. A content-only edit by
 * the same person within 10 minutes of their previous content-only edit continues that session
 * instead of adding another audit row.
 */
async function isContinuingEditSession(db: Db, actor: Actor, entryId: string, changes: Record<string, unknown>) {
  if (Object.keys(changes).join() !== "content") return false;
  const [last] = await db
    .select()
    .from(auditEvents)
    .where(eq(auditEvents.objectId, entryId))
    .orderBy(desc(auditEvents.at), desc(auditEvents.id))
    .limit(1);
  return (
    !!last &&
    last.action === "update" &&
    last.actorId === actor.id &&
    Object.keys(last.changes).join() === "content" &&
    Date.now() - last.at.getTime() < EDIT_SESSION_MS
  );
}

// ---------------------------------------------------------------------------------------------
// Results: rows of a result schema, usually captured inside an entry.

export async function createResults(
  db: Db,
  actor: Actor,
  input: { schemaId: string; entryId?: string | null; rows: Record<string, unknown>[] },
) {
  if (!input.rows.length) throw new ValidationError("At least one result row is required");
  if (input.rows.length > 1000) throw new ValidationError("At most 1000 result rows per request");
  return db.transaction(async (tx) => {
    const schema = await getSchema(tx, input.schemaId);
    if (schema.kind !== "result") throw new ValidationError(`Schema ${schema.id} is not a result schema`);
    if (input.entryId) {
      const entry = await getEntry(tx, input.entryId);
      if (entry.archivedAt) throw new ValidationError("Cannot add results to an archived entry");
    }
    const rows = [];
    for (const [i, row] of input.rows.entries()) {
      try {
        rows.push({
          id: newId("result"),
          schemaId: schema.id,
          entryId: input.entryId ?? null,
          fields: await validateFieldsAgainstSchema(tx, schema, row, "create"),
          createdById: actor.id,
        });
      } catch (e) {
        if (e instanceof ValidationError) {
          throw new ValidationError(
            `Invalid result row ${i}`,
            e.fieldErrors.map((fe) => ({ field: `rows[${i}].${fe.field}`, message: fe.message })),
          );
        }
        throw e;
      }
    }
    const inserted = await tx.insert(results).values(rows).returning();
    for (const r of inserted) await recordAudit(tx, actor, r.id, "create");
    return inserted;
  });
}

export async function listResults(db: Db, where: { schemaId?: string; entryId?: string; ids?: string[] }) {
  return db
    .select()
    .from(results)
    .where(
      and(
        isNull(results.archivedAt),
        where.schemaId ? eq(results.schemaId, where.schemaId) : undefined,
        where.entryId ? eq(results.entryId, where.entryId) : undefined,
        where.ids ? inArray(results.id, where.ids) : undefined,
      ),
    )
    .orderBy(asc(results.seq));
}
