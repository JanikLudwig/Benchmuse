import { and, asc, eq, isNull } from "drizzle-orm";
import type { Db } from "../db/client";
import { entities, entries, folders, projects } from "../db/schema";
import { newId } from "../domain/ids";
import { diff, recordAudit, type Actor } from "./audit";
import { NotFoundError, ValidationError } from "./errors";

export function requireName(name: string | undefined, what: string): string {
  const trimmed = name?.trim();
  if (!trimmed) throw new ValidationError(`${what} name is required`);
  if (trimmed.length > 200) throw new ValidationError(`${what} name must be at most 200 characters`);
  return trimmed;
}

/** Creates the project together with its root folder; items placed "in the project" live in the root folder. */
export async function createProject(db: Db, actor: Actor, input: { name: string; description?: string }) {
  return db.transaction(async (tx) => {
    const [project] = await tx
      .insert(projects)
      .values({
        id: newId("project"),
        name: requireName(input.name, "Project"),
        description: input.description?.trim() ?? "",
        createdById: actor.id,
      })
      .returning();
    await tx.insert(folders).values({
      id: newId("folder"),
      projectId: project!.id,
      parentFolderId: null,
      name: project!.name,
      createdById: actor.id,
    });
    await recordAudit(tx, actor, project!.id, "create", { name: { from: null, to: project!.name } });
    return project!;
  });
}

export async function listProjects(db: Db, opts: { includeArchived?: boolean } = {}) {
  return db
    .select()
    .from(projects)
    .where(opts.includeArchived ? undefined : isNull(projects.archivedAt))
    .orderBy(asc(projects.name));
}

export async function getProject(db: Db, id: string) {
  const [project] = await db.select().from(projects).where(eq(projects.id, id));
  if (!project) throw new NotFoundError("Project", id);
  return project;
}

export async function getProjectRootFolder(db: Db, projectId: string) {
  const [root] = await db
    .select()
    .from(folders)
    .where(and(eq(folders.projectId, projectId), isNull(folders.parentFolderId)));
  if (!root) throw new NotFoundError("Root folder of project", projectId);
  return root;
}

export async function updateProject(db: Db, actor: Actor, id: string, patch: { name?: string; description?: string }) {
  return db.transaction(async (tx) => {
    const before = await getProject(tx, id);
    const values = {
      ...(patch.name !== undefined && { name: requireName(patch.name, "Project") }),
      ...(patch.description !== undefined && { description: patch.description.trim() }),
    };
    const [after] = await tx
      .update(projects)
      .set({ ...values, modifiedAt: new Date() })
      .where(eq(projects.id, id))
      .returning();
    if (values.name) {
      await tx
        .update(folders)
        .set({ name: values.name })
        .where(and(eq(folders.projectId, id), isNull(folders.parentFolderId)));
    }
    const changes = diff(before, after!, ["name", "description"]);
    if (Object.keys(changes).length) await recordAudit(tx, actor, id, "update", changes);
    return after!;
  });
}

export async function getFolder(db: Db, id: string) {
  const [folder] = await db.select().from(folders).where(eq(folders.id, id));
  if (!folder) throw new NotFoundError("Folder", id);
  return folder;
}

/** A folder that can receive new items: exists and is not archived. */
export async function getWritableFolder(db: Db, id: string) {
  const folder = await getFolder(db, id);
  if (folder.archivedAt) throw new ValidationError(`Folder ${id} is archived`);
  return folder;
}

/** `parentFolderId` defaults to the project's root folder. */
export async function createFolder(
  db: Db,
  actor: Actor,
  input: { name: string; projectId?: string; parentFolderId?: string },
) {
  return db.transaction(async (tx) => {
    let parent;
    if (input.parentFolderId) {
      parent = await getWritableFolder(tx, input.parentFolderId);
      if (input.projectId && parent.projectId !== input.projectId) {
        throw new ValidationError("Parent folder belongs to a different project");
      }
    } else if (input.projectId) {
      parent = await getProjectRootFolder(tx, input.projectId);
    } else {
      throw new ValidationError("Either projectId or parentFolderId is required");
    }
    const [folder] = await tx
      .insert(folders)
      .values({
        id: newId("folder"),
        name: requireName(input.name, "Folder"),
        projectId: parent.projectId,
        parentFolderId: parent.id,
        createdById: actor.id,
      })
      .returning();
    await recordAudit(tx, actor, folder!.id, "create", { name: { from: null, to: folder!.name } });
    return folder!;
  });
}

/** Folder path from the project root down to `id` (inclusive), for breadcrumbs. */
export async function getFolderPath(db: Db, id: string) {
  const path = [];
  let current: string | null = id;
  for (let depth = 0; current && depth < 100; depth++) {
    const folder = await getFolder(db, current);
    path.unshift(folder);
    current = folder.parentFolderId;
  }
  return path;
}

export async function moveFolder(db: Db, actor: Actor, id: string, newParentFolderId: string) {
  return db.transaction(async (tx) => {
    const folder = await getFolder(tx, id);
    if (!folder.parentFolderId) throw new ValidationError("A project's root folder cannot be moved");
    await getWritableFolder(tx, newParentFolderId);
    const parentPath = await getFolderPath(tx, newParentFolderId);
    if (parentPath[0]!.projectId !== folder.projectId) throw new ValidationError("Cannot move a folder to another project");
    if (parentPath.some((f) => f.id === id)) throw new ValidationError("Cannot move a folder into itself or its descendants");
    const [after] = await tx
      .update(folders)
      .set({ parentFolderId: newParentFolderId, modifiedAt: new Date() })
      .where(eq(folders.id, id))
      .returning();
    await recordAudit(tx, actor, id, "move", { parentFolderId: { from: folder.parentFolderId, to: newParentFolderId } });
    return after!;
  });
}

/** Direct children of a folder: subfolders, entities, entries. */
export async function listFolderContents(db: Db, folderId: string, opts: { includeArchived?: boolean } = {}) {
  await getFolder(db, folderId);
  const live = <T extends typeof folders.archivedAt | typeof entities.archivedAt | typeof entries.archivedAt>(col: T) =>
    opts.includeArchived ? undefined : isNull(col);
  const subfolders = await db
    .select()
    .from(folders)
    .where(and(eq(folders.parentFolderId, folderId), live(folders.archivedAt)))
    .orderBy(asc(folders.name));
  const entityRows = await db
    .select()
    .from(entities)
    .where(and(eq(entities.folderId, folderId), live(entities.archivedAt)))
    .orderBy(asc(entities.name));
  const entryRows = await db
    .select()
    .from(entries)
    .where(and(eq(entries.folderId, folderId), live(entries.archivedAt)))
    .orderBy(asc(entries.name));
  return { folders: subfolders, entities: entityRows, entries: entryRows };
}
