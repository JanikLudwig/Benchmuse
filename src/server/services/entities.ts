import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import type { Db } from "../db/client";
import { dropdownOptions, entities, entries, type EntityType, type OligoRole, schemas } from "../db/schema";
import { validateFieldValues, type FieldError, type FieldReference, type FieldValues } from "../domain/fields";
import { isIdOf, newId } from "../domain/ids";
import { parseNameTemplate, renderNameTemplate } from "../domain/nameTemplates";

import {
  canBeCircular,
  checkFeatures,
  checkSequence,
  isSequenceType,
  type FeatureInput,
} from "./sequenceSupport";
import { diff, recordAudit, type Actor } from "./audit";
import { ConflictError, NotFoundError, ValidationError } from "./errors";
import { getWritableFolder, requireName } from "./projects";
import { getSchema } from "./schemas";

/** Check that every dropdown option / linked entity referenced by field values exists and fits. */
export async function verifyReferences(db: Db, refs: FieldReference[]): Promise<FieldError[]> {
  const errors: FieldError[] = [];
  const optionRefs = refs.filter((r) => r.kind === "dropdown_option");
  const entityRefs = refs.filter((r) => r.kind === "entity");

  if (optionRefs.length) {
    const rows = await db
      .select()
      .from(dropdownOptions)
      .where(inArray(dropdownOptions.id, optionRefs.map((r) => r.id)));
    for (const ref of optionRefs) {
      const row = rows.find((o) => o.id === ref.id);
      if (!row || row.dropdownId !== ref.dropdownId) errors.push({ field: ref.fieldName, message: `${ref.id} is not an option of this dropdown` });
      else if (row.archivedAt) errors.push({ field: ref.fieldName, message: `option '${row.name}' is archived` });
    }
  }
  if (entityRefs.length) {
    const rows = await db
      .select({ id: entities.id, schemaId: entities.schemaId, archivedAt: entities.archivedAt })
      .from(entities)
      .where(inArray(entities.id, entityRefs.map((r) => r.id)));
    for (const ref of entityRefs) {
      const row = rows.find((e) => e.id === ref.id);
      if (!row) errors.push({ field: ref.fieldName, message: `entity ${ref.id} not found` });
      else if (ref.targetSchemaId && row.schemaId !== ref.targetSchemaId) {
        errors.push({ field: ref.fieldName, message: `entity ${ref.id} has the wrong schema for this link` });
      }
    }
  }
  return errors;
}

/** Validate field values against a schema and its references; throws ValidationError. */
export async function validateFieldsAgainstSchema(
  db: Db,
  schema: Awaited<ReturnType<typeof getSchema>> | null,
  input: Record<string, unknown> | undefined,
  mode: "create" | "update",
): Promise<FieldValues> {
  if (!schema) {
    if (input && Object.keys(input).length) throw new ValidationError("Objects without a schema cannot have field values");
    return {};
  }
  const result = validateFieldValues(schema.fields, input ?? {}, mode);
  if (!result.ok) throw new ValidationError("Invalid field values", result.errors);
  const refErrors = await verifyReferences(db, result.references);
  if (refErrors.length) throw new ValidationError("Invalid field values", refErrors);
  return result.values;
}

export interface CreateEntityInput {
  name: string;
  folderId: string;
  schemaId?: string | null;
  /** required when schemaId is absent; otherwise taken from the schema */
  entityType?: EntityType;
  fields?: Record<string, unknown>;
  aliases?: string[];
  sequence?: string;
  isCircular?: boolean;
  features?: FeatureInput[];
  /** dna_oligo only */
  oligoRole?: OligoRole | null;
  /** file this entity was imported from */
  sourceFileId?: string | null;
  /** per-base phred scores, for sequences read from a chromatogram */
  qualities?: number[] | null;
}

export async function createEntity(db: Db, actor: Actor, input: CreateEntityInput) {
  return db.transaction(async (tx) => {
    await getWritableFolder(tx, input.folderId);
    const schema = input.schemaId ? await getSchema(tx, input.schemaId) : null;
    if (schema && schema.kind !== "entity") throw new ValidationError(`Schema ${schema.id} is not an entity schema`);
    if (schema?.archivedAt) throw new ValidationError(`Schema '${schema.name}' is archived`);
    const entityType = schema?.entityType ?? input.entityType;
    if (!entityType) throw new ValidationError("entityType is required for entities without a schema");
    if (schema && input.entityType && input.entityType !== schema.entityType) {
      throw new ValidationError(`Schema '${schema.name}' is for ${schema.entityType} entities`);
    }
    if (!schema && entityType === "custom") throw new ValidationError("Custom entities require a schema");

    const sequence = checkSequence(entityType, input.sequence);
    const isCircular = canBeCircular(entityType) ? (input.isCircular ?? false) : false;
    const features = checkFeatures(entityType, input.features, sequence, isCircular);
    if (input.oligoRole && entityType !== "dna_oligo") throw new ValidationError("Only oligos have a role");
    if (input.qualities && sequence && input.qualities.length !== sequence.length) {
      throw new ValidationError("Quality scores must line up with the sequence");
    }
    const fields = await validateFieldsAgainstSchema(tx, schema, input.fields, "create");

    const [entity] = await tx
      .insert(entities)
      .values({
        id: newId("entity"),
        schemaId: schema?.id ?? null,
        entityType,
        name: requireName(input.name, "Entity"),
        folderId: input.folderId,
        fields,
        aliases: [...new Set((input.aliases ?? []).map((a) => a.trim()).filter(Boolean))],
        sequence,
        isCircular,
        features,
        qualities: input.qualities ?? null,
        oligoRole: input.oligoRole ?? null,
        sourceFileId: input.sourceFileId ?? null,
        createdById: actor.id,
      })
      .returning();
    await recordAudit(tx, actor, entity!.id, "create", { name: { from: null, to: entity!.name } });
    return entity!;
  });
}

export async function getEntity(db: Db, id: string) {
  const [entity] = await db.select().from(entities).where(eq(entities.id, id));
  if (!entity) throw new NotFoundError("Entity", id);
  return entity;
}

export interface UpdateEntityInput {
  name?: string;
  fields?: Record<string, unknown>;
  aliases?: string[];
  sequence?: string;
  isCircular?: boolean;
  features?: FeatureInput[];
  oligoRole?: OligoRole | null;
}

export async function updateEntity(db: Db, actor: Actor, id: string, patch: UpdateEntityInput) {
  return db.transaction(async (tx) => {
    const before = await getEntity(tx, id);
    if (before.archivedAt) throw new ValidationError("Archived entities cannot be edited; unarchive first");
    const schema = before.schemaId ? await getSchema(tx, before.schemaId) : null;
    const fieldPatch = patch.fields ? await validateFieldsAgainstSchema(tx, schema, patch.fields, "update") : {};

    const sequence = patch.sequence !== undefined ? checkSequence(before.entityType, patch.sequence) : before.sequence;
    if (before.registryId && patch.sequence !== undefined && sequence !== before.sequence) {
      throw new ConflictError("The sequence of a registered entity is immutable");
    }
    const isCircular =
      canBeCircular(before.entityType) && patch.isCircular !== undefined ? patch.isCircular : before.isCircular;
    let features = before.features;
    if (patch.features !== undefined) {
      features = checkFeatures(before.entityType, patch.features, sequence, isCircular);
    } else if (sequence !== before.sequence || isCircular !== before.isCircular) {
      // Existing features must still fit the edited sequence and topology.
      checkFeatures(before.entityType, before.features, sequence, isCircular);
    }

    const [after] = await tx
      .update(entities)
      .set({
        ...(patch.name !== undefined && { name: requireName(patch.name, "Entity") }),
        ...(patch.aliases !== undefined && { aliases: [...new Set(patch.aliases.map((a) => a.trim()).filter(Boolean))] }),
        fields: { ...before.fields, ...fieldPatch },
        ...(patch.oligoRole !== undefined && { oligoRole: patch.oligoRole }),
        sequence,
        isCircular,
        features,
        modifiedAt: new Date(),
      })
      .where(eq(entities.id, id))
      .returning();
    const changes = diff(before, after!, ["name", "aliases", "fields", "sequence", "isCircular", "features", "oligoRole"]);
    if (Object.keys(changes).length) await recordAudit(tx, actor, id, "update", changes);
    return after!;
  });
}

export async function moveEntity(db: Db, actor: Actor, id: string, folderId: string) {
  return db.transaction(async (tx) => {
    const before = await getEntity(tx, id);
    await getWritableFolder(tx, folderId);
    const [after] = await tx.update(entities).set({ folderId, modifiedAt: new Date() }).where(eq(entities.id, id)).returning();
    await recordAudit(tx, actor, id, "move", { folderId: { from: before.folderId, to: folderId } });
    return after!;
  });
}

/**
 * Assign a registry ID from the schema's name template. The counter increment is a single
 * `UPDATE ... RETURNING`, so concurrent registrations never get the same number.
 */
export async function registerEntity(db: Db, actor: Actor, id: string) {
  return db.transaction(async (tx) => {
    const entity = await getEntity(tx, id);
    if (entity.registryId) throw new ConflictError(`Entity is already registered as ${entity.registryId}`);
    if (entity.archivedAt) throw new ValidationError("Archived entities cannot be registered");
    if (!entity.schemaId) throw new ValidationError("Only entities with a schema can be registered");
    const schema = await getSchema(tx, entity.schemaId);
    if (!schema.nameTemplate) throw new ValidationError(`Schema '${schema.name}' has no registry name template`);
    const template = parseNameTemplate(schema.nameTemplate);
    if (!template.ok) throw new ValidationError(`Schema name template is invalid: ${template.error}`);

    // Required fields must be filled before registration even if they were added after creation.
    const missing = schema.fields.filter((f) => f.isRequired && !f.archivedAt && (entity.fields[f.name] ?? null) === null);
    if (missing.length) {
      throw new ValidationError(
        "Fill in required fields before registering",
        missing.map((f) => ({ field: f.name, message: "is required" })),
      );
    }

    const now = new Date();
    for (let attempt = 0; attempt < 50; attempt++) {
      const [{ n }] = (await tx
        .update(schemas)
        .set({ nextNumber: sql`${schemas.nextNumber} + 1` })
        .where(eq(schemas.id, schema.id))
        .returning({ n: sql<number>`${schemas.nextNumber} - 1` })) as [{ n: number }];
      const registryId = renderNameTemplate(template.parts, n, now);
      const [taken] = await tx.select({ id: entities.id }).from(entities).where(eq(entities.registryId, registryId));
      if (taken) continue; // the template changed and collides with an older ID; take the next number
      const [after] = await tx
        .update(entities)
        .set({ registryId, registeredAt: now, modifiedAt: now })
        .where(and(eq(entities.id, id), isNull(entities.registryId)))
        .returning();
      await recordAudit(tx, actor, id, "register", { registryId: { from: null, to: registryId } });
      return after!;
    }
    throw new ConflictError("Could not allocate a free registry ID; check the schema's name template");
  });
}

export async function getEntitiesByIds(db: Db, ids: string[]) {
  const valid = [...new Set(ids)].filter((id) => isIdOf("entity", id));
  return valid.length ? db.select().from(entities).where(inArray(entities.id, valid)) : [];
}

/** Display names for entity IDs (e.g. values of link fields), registry ID appended when present. */
export async function getEntityNames(db: Db, ids: string[]): Promise<Record<string, string>> {
  const unique = [...new Set(ids)].filter((id) => isIdOf("entity", id));
  if (!unique.length) return {};
  const rows = await db
    .select({ id: entities.id, name: entities.name, registryId: entities.registryId })
    .from(entities)
    .where(inArray(entities.id, unique));
  return Object.fromEntries(rows.map((r) => [r.id, r.registryId ? `${r.name} (${r.registryId})` : r.name]));
}

/**
 * Objects that point at `id`: entities linking to it through a field, and entries mentioning it.
 * IDs are 12 random base62 characters, so a quoted substring match has no realistic false positives.
 */
export async function getBacklinks(db: Db, id: string) {
  const needle = `%"${id}"%`;
  const [linkingEntities, mentioningEntries] = await Promise.all([
    db
      .select({ id: entities.id, name: entities.name, registryId: entities.registryId, entityType: entities.entityType })
      .from(entities)
      .where(and(isNull(entities.archivedAt), sql`${entities.fields}::text like ${needle}`)),
    db
      .select({ id: entries.id, name: entries.name })
      .from(entries)
      .where(and(isNull(entries.archivedAt), sql`${entries.content}::text like ${needle}`)),
  ]);
  return { entities: linkingEntities, entries: mentioningEntries };
}
