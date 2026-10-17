import { eq } from "drizzle-orm";
import type { Db } from "../db/client";
import { ARCHIVE_REASONS, dropdowns, entities, entries, folders, projects, results, schemas, type ArchiveReason } from "../db/schema";
import { kindOfId, type ObjectKind } from "../domain/ids";
import { recordAudit, type Actor } from "./audit";
import { NotFoundError, ValidationError } from "./errors";

const ARCHIVABLE = {
  project: projects,
  folder: folders,
  entity: entities,
  entry: entries,
  result: results,
  schema: schemas,
  dropdown: dropdowns,
} as const satisfies Partial<Record<ObjectKind, unknown>>;

type ArchivableKind = keyof typeof ARCHIVABLE;

function tableFor(id: string) {
  const kind = kindOfId(id);
  if (!kind || !(kind in ARCHIVABLE)) throw new ValidationError(`${id} is not an archivable object`);
  return ARCHIVABLE[kind as ArchivableKind];
}

/**
 * Archiving is Benchmuse's delete: the object disappears from default views and search but keeps
 * its ID, history and links. Archiving a project or folder does not cascade to its contents.
 */
export async function setArchived(db: Db, actor: Actor, ids: string[], reason: ArchiveReason | null) {
  if (!ids.length) throw new ValidationError("No objects given");
  if (reason !== null && !ARCHIVE_REASONS.includes(reason)) {
    throw new ValidationError(`Archive reason must be one of: ${ARCHIVE_REASONS.join(", ")}`);
  }
  return db.transaction(async (tx) => {
    for (const id of ids) {
      const table = tableFor(id);
      const [before] = await tx.select({ archivedAt: table.archivedAt, archiveReason: table.archiveReason }).from(table).where(eq(table.id, id));
      if (!before) throw new NotFoundError("Object", id);
      if (kindOfId(id) === "folder") {
        const [folder] = await tx.select({ parent: folders.parentFolderId }).from(folders).where(eq(folders.id, id));
        if (!folder!.parent) throw new ValidationError("Archive the project instead of its root folder");
      }
      if (reason && before.archivedAt) continue; // already archived: idempotent
      if (!reason && !before.archivedAt) continue;
      await tx
        .update(table)
        .set({ archivedAt: reason ? new Date() : null, archiveReason: reason, modifiedAt: new Date() })
        .where(eq(table.id, id));
      await recordAudit(tx, actor, id, reason ? "archive" : "unarchive", {
        archiveReason: { from: before.archiveReason, to: reason },
      });
    }
  });
}
