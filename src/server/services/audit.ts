import { desc, eq } from "drizzle-orm";
import type { Db } from "../db/client";
import { auditEvents, type AuditAction, type AuditChanges } from "../db/schema";
import { newId } from "../domain/ids";

export interface Actor {
  id: string;
}

export async function recordAudit(
  db: Db,
  actor: Actor,
  objectId: string,
  action: AuditAction,
  changes: AuditChanges = {},
): Promise<void> {
  await db.insert(auditEvents).values({ id: newId("auditEvent"), objectId, action, actorId: actor.id, changes });
}

export async function listAudit(db: Db, objectId: string) {
  return db.select().from(auditEvents).where(eq(auditEvents.objectId, objectId)).orderBy(desc(auditEvents.at), desc(auditEvents.id));
}

const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/**
 * Field-level diff between two snapshots, restricted to `keys`. Nested `fields` objects are
 * flattened to `fields.<name>` so the audit log shows exactly which schema field changed.
 */
export function diff(before: Record<string, unknown>, after: Record<string, unknown>, keys: readonly string[]): AuditChanges {
  const changes: AuditChanges = {};
  for (const key of keys) {
    if (key === "fields") {
      const from = (before.fields ?? {}) as Record<string, unknown>;
      const to = (after.fields ?? {}) as Record<string, unknown>;
      for (const name of new Set([...Object.keys(from), ...Object.keys(to)])) {
        if (!same(from[name], to[name])) changes[`fields.${name}`] = { from: from[name] ?? null, to: to[name] ?? null };
      }
    } else if (!same(before[key], after[key])) {
      changes[key] = { from: before[key] ?? null, to: after[key] ?? null };
    }
  }
  return changes;
}
