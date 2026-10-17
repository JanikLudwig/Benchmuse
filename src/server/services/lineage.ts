/**
 * Construct lineage: which entities a new one was made from, and how.
 */

import { desc, eq, inArray } from "drizzle-orm";
import type { Db } from "../db/client";
import { entities, lineage, type ConstructMethod } from "../db/schema";
import { newId } from "../domain/ids";
import type { Actor } from "./audit";

export interface RecordLineageInput {
  childEntityId: string;
  /** omitted for methods with no parent entity, such as import or synthesis */
  parentEntityId?: string | null;
  method: ConstructMethod;
  role?: string;
  details?: Record<string, unknown>;
}

export async function recordLineage(db: Db, actor: Actor, input: RecordLineageInput | RecordLineageInput[]) {
  const rows = (Array.isArray(input) ? input : [input]).map((entry) => ({
    id: newId("lineage"),
    childEntityId: entry.childEntityId,
    parentEntityId: entry.parentEntityId ?? null,
    method: entry.method,
    role: entry.role ?? null,
    details: entry.details ?? {},
    createdById: actor.id,
  }));
  if (!rows.length) return [];
  return db.insert(lineage).values(rows).returning();
}

export interface LineageNode {
  entityId: string;
  name: string;
  registryId: string | null;
  entityType: string;
  archivedAt: Date | null;
}

export interface LineageEdge {
  parentEntityId: string | null;
  childEntityId: string;
  method: ConstructMethod;
  role: string | null;
  details: Record<string, unknown>;
  createdAt: Date;
}

/**
 * Walk the lineage graph around an entity, up to `depth` steps in each direction.
 *
 * Returns a node and edge list ready for the UI to draw, with cycles broken by visiting each
 * entity once.
 */
export async function getLineageGraph(db: Db, entityId: string, depth = 3): Promise<{ nodes: LineageNode[]; edges: LineageEdge[] }> {
  const visited = new Set<string>([entityId]);
  const edges: LineageEdge[] = [];
  const seenEdges = new Set<string>();

  let frontier = [entityId];
  for (let step = 0; step < depth && frontier.length; step++) {
    const [parents, children] = await Promise.all([
      db.select().from(lineage).where(inArray(lineage.childEntityId, frontier)),
      db.select().from(lineage).where(inArray(lineage.parentEntityId, frontier)),
    ]);
    const next: string[] = [];
    for (const row of [...parents, ...children]) {
      const key = `${row.parentEntityId ?? "-"}>${row.childEntityId}:${row.method}`;
      if (!seenEdges.has(key)) {
        seenEdges.add(key);
        edges.push({
          parentEntityId: row.parentEntityId,
          childEntityId: row.childEntityId,
          method: row.method,
          role: row.role,
          details: row.details,
          createdAt: row.createdAt,
        });
      }
      for (const id of [row.parentEntityId, row.childEntityId]) {
        if (id && !visited.has(id)) {
          visited.add(id);
          next.push(id);
        }
      }
    }
    frontier = next;
  }

  const nodes = visited.size
    ? await db
        .select({
          entityId: entities.id,
          name: entities.name,
          registryId: entities.registryId,
          entityType: entities.entityType,
          archivedAt: entities.archivedAt,
        })
        .from(entities)
        .where(inArray(entities.id, [...visited]))
    : [];
  return { nodes, edges };
}

/** Direct parents of an entity, for the detail panel. */
export async function getParents(db: Db, entityId: string) {
  return db.select().from(lineage).where(eq(lineage.childEntityId, entityId)).orderBy(desc(lineage.createdAt));
}

/** Entities made from this one. */
export async function getChildren(db: Db, entityId: string) {
  return db.select().from(lineage).where(eq(lineage.parentEntityId, entityId)).orderBy(desc(lineage.createdAt));
}
