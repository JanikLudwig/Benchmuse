import { and, asc, eq, inArray, isNull, max } from "drizzle-orm";
import type { Db } from "../db/client";
import {
  dropdownOptions,
  dropdowns,
  ENTITY_TYPES,
  schemaFields,
  schemas,
  SCHEMA_KINDS,
  type EntityType,
  type SchemaKind,
} from "../db/schema";
import { validateFieldDefinition, type FieldDefinition, type FieldType } from "../domain/fields";
import { newId } from "../domain/ids";
import { parseNameTemplate } from "../domain/nameTemplates";
import { diff, recordAudit, type Actor } from "./audit";
import { NotFoundError, rethrowUniqueViolation, ValidationError } from "./errors";
import { requireName } from "./projects";

// ---------------------------------------------------------------------------------------------
// Dropdowns

export async function createDropdown(db: Db, actor: Actor, input: { name: string; options: string[] }) {
  const optionNames = input.options.map((o) => o.trim()).filter(Boolean);
  if (new Set(optionNames).size !== optionNames.length) throw new ValidationError("Dropdown options must be unique");
  return db.transaction(async (tx) => {
    const id = newId("dropdown");
    try {
      await tx.insert(dropdowns).values({ id, name: requireName(input.name, "Dropdown"), createdById: actor.id });
    } catch (e) {
      rethrowUniqueViolation(e, `A dropdown named '${input.name.trim()}' already exists`);
    }
    if (optionNames.length) {
      await tx
        .insert(dropdownOptions)
        .values(optionNames.map((name, position) => ({ id: newId("dropdownOption"), dropdownId: id, name, position })));
    }
    await recordAudit(tx, actor, id, "create", { name: { from: null, to: input.name.trim() } });
    return getDropdown(tx, id);
  });
}

export async function getDropdown(db: Db, id: string) {
  const [dropdown] = await db.select().from(dropdowns).where(eq(dropdowns.id, id));
  if (!dropdown) throw new NotFoundError("Dropdown", id);
  const options = await db
    .select()
    .from(dropdownOptions)
    .where(eq(dropdownOptions.dropdownId, id))
    .orderBy(asc(dropdownOptions.position));
  return { ...dropdown, options };
}

export async function listDropdowns(db: Db) {
  const rows = await db.select().from(dropdowns).where(isNull(dropdowns.archivedAt)).orderBy(asc(dropdowns.name));
  const options = rows.length
    ? await db
        .select()
        .from(dropdownOptions)
        .where(inArray(dropdownOptions.dropdownId, rows.map((r) => r.id)))
        .orderBy(asc(dropdownOptions.position))
    : [];
  return rows.map((d) => ({ ...d, options: options.filter((o) => o.dropdownId === d.id) }));
}

export async function addDropdownOption(db: Db, actor: Actor, dropdownId: string, name: string) {
  return db.transaction(async (tx) => {
    await getDropdown(tx, dropdownId);
    const [{ last }] = (await tx
      .select({ last: max(dropdownOptions.position) })
      .from(dropdownOptions)
      .where(eq(dropdownOptions.dropdownId, dropdownId))) as [{ last: number | null }];
    try {
      const [option] = await tx
        .insert(dropdownOptions)
        .values({ id: newId("dropdownOption"), dropdownId, name: requireName(name, "Option"), position: (last ?? -1) + 1 })
        .returning();
      await recordAudit(tx, actor, dropdownId, "update", { [`options.${option!.id}`]: { from: null, to: option!.name } });
      return option!;
    } catch (e) {
      rethrowUniqueViolation(e, `Option '${name.trim()}' already exists`);
    }
  });
}

// ---------------------------------------------------------------------------------------------
// Schemas and fields

export interface FieldInput {
  name: string;
  displayName: string;
  type: FieldType;
  isRequired?: boolean;
  isMulti?: boolean;
  dropdownId?: string | null;
  targetSchemaId?: string | null;
}

export interface SchemaInput {
  kind: SchemaKind;
  name: string;
  description?: string;
  entityType?: EntityType;
  nameTemplate?: string | null;
  fields?: FieldInput[];
}

function normalizeField(input: FieldInput) {
  return {
    name: input.name,
    displayName: input.displayName?.trim() ?? "",
    type: input.type,
    isRequired: input.isRequired ?? false,
    isMulti: input.isMulti ?? false,
    dropdownId: input.dropdownId ?? null,
    targetSchemaId: input.targetSchemaId ?? null,
  };
}

/** Definition-level checks plus existence of referenced dropdowns / target schemas. */
async function checkFieldInputs(db: Db, fields: ReturnType<typeof normalizeField>[]) {
  const errors = fields.flatMap((f) => validateFieldDefinition(f));
  const names = fields.map((f) => f.name);
  const duplicate = names.find((n, i) => names.indexOf(n) !== i);
  if (duplicate) errors.push({ field: duplicate, message: "duplicate field name" });
  if (errors.length) throw new ValidationError("Invalid field definitions", errors);

  const dropdownIds = [...new Set(fields.map((f) => f.dropdownId).filter((x): x is string => !!x))];
  if (dropdownIds.length) {
    const found = await db.select({ id: dropdowns.id }).from(dropdowns).where(inArray(dropdowns.id, dropdownIds));
    const missing = dropdownIds.filter((id) => !found.some((f) => f.id === id));
    if (missing.length) throw new ValidationError(`Unknown dropdown(s): ${missing.join(", ")}`);
  }
  const targetIds = [...new Set(fields.map((f) => f.targetSchemaId).filter((x): x is string => !!x))];
  if (targetIds.length) {
    const found = await db.select({ id: schemas.id, kind: schemas.kind }).from(schemas).where(inArray(schemas.id, targetIds));
    for (const id of targetIds) {
      const target = found.find((f) => f.id === id);
      if (!target) throw new ValidationError(`Unknown target schema ${id}`);
      if (target.kind !== "entity") throw new ValidationError(`Link target ${id} is not an entity schema`);
    }
  }
}

function checkSchemaShape(input: { kind: SchemaKind; entityType?: EntityType | null; nameTemplate?: string | null }) {
  if (!SCHEMA_KINDS.includes(input.kind)) throw new ValidationError(`Unknown schema kind '${input.kind}'`);
  if (input.kind === "entity") {
    if (!input.entityType || !ENTITY_TYPES.includes(input.entityType)) {
      throw new ValidationError(`Entity schemas need an entityType: ${ENTITY_TYPES.join(", ")}`);
    }
  } else if (input.entityType) {
    throw new ValidationError("entityType is only valid on entity schemas");
  }
  if (input.nameTemplate) {
    if (input.kind !== "entity") throw new ValidationError("Only entity schemas can have a registry name template");
    const parsed = parseNameTemplate(input.nameTemplate);
    if (!parsed.ok) throw new ValidationError(`Invalid name template: ${parsed.error}`);
  }
}

export async function createSchema(db: Db, actor: Actor, input: SchemaInput) {
  checkSchemaShape(input);
  const fields = (input.fields ?? []).map(normalizeField);
  return db.transaction(async (tx) => {
    await checkFieldInputs(tx, fields);
    const id = newId("schema");
    try {
      await tx.insert(schemas).values({
        id,
        kind: input.kind,
        name: requireName(input.name, "Schema"),
        description: input.description?.trim() ?? "",
        entityType: input.kind === "entity" ? input.entityType! : null,
        nameTemplate: input.nameTemplate || null,
        createdById: actor.id,
      });
    } catch (e) {
      rethrowUniqueViolation(e, `A schema named '${input.name.trim()}' already exists`);
    }
    if (fields.length) {
      await tx.insert(schemaFields).values(fields.map((f, position) => ({ ...f, id: newId("field"), schemaId: id, position })));
    }
    await recordAudit(tx, actor, id, "create", { name: { from: null, to: input.name.trim() } });
    return getSchema(tx, id);
  });
}

export type SchemaWithFields = Awaited<ReturnType<typeof getSchema>>;

export async function getSchema(db: Db, id: string) {
  const [schema] = await db.select().from(schemas).where(eq(schemas.id, id));
  if (!schema) throw new NotFoundError("Schema", id);
  const fields = await db.select().from(schemaFields).where(eq(schemaFields.schemaId, id)).orderBy(asc(schemaFields.position));
  return { ...schema, fields };
}

export async function listSchemas(db: Db, opts: { kind?: SchemaKind } = {}) {
  const rows = await db
    .select()
    .from(schemas)
    .where(and(isNull(schemas.archivedAt), opts.kind ? eq(schemas.kind, opts.kind) : undefined))
    .orderBy(asc(schemas.name));
  const fields = rows.length
    ? await db
        .select()
        .from(schemaFields)
        .where(inArray(schemaFields.schemaId, rows.map((r) => r.id)))
        .orderBy(asc(schemaFields.position))
    : [];
  return rows.map((s) => ({ ...s, fields: fields.filter((f) => f.schemaId === s.id) }));
}

export async function updateSchema(
  db: Db,
  actor: Actor,
  id: string,
  patch: { name?: string; description?: string; nameTemplate?: string | null },
) {
  return db.transaction(async (tx) => {
    const before = await getSchema(tx, id);
    if (patch.nameTemplate !== undefined) checkSchemaShape({ ...before, nameTemplate: patch.nameTemplate });
    const values = {
      ...(patch.name !== undefined && { name: requireName(patch.name, "Schema") }),
      ...(patch.description !== undefined && { description: patch.description.trim() }),
      ...(patch.nameTemplate !== undefined && { nameTemplate: patch.nameTemplate || null }),
    };
    try {
      await tx.update(schemas).set({ ...values, modifiedAt: new Date() }).where(eq(schemas.id, id));
    } catch (e) {
      rethrowUniqueViolation(e, `A schema named '${patch.name?.trim()}' already exists`);
    }
    const after = await getSchema(tx, id);
    const changes = diff(before, after, ["name", "description", "nameTemplate"]);
    if (Object.keys(changes).length) await recordAudit(tx, actor, id, "update", changes);
    return after;
  });
}

export async function addSchemaField(db: Db, actor: Actor, schemaId: string, input: FieldInput) {
  const field = normalizeField(input);
  return db.transaction(async (tx) => {
    const schema = await getSchema(tx, schemaId);
    await checkFieldInputs(tx, [field]);
    if (schema.fields.some((f) => f.name === field.name)) {
      throw new ValidationError("Invalid field definitions", [{ field: field.name, message: "duplicate field name" }]);
    }
    const position = schema.fields.length ? Math.max(...schema.fields.map((f) => f.position)) + 1 : 0;
    const [row] = await tx.insert(schemaFields).values({ ...field, id: newId("field"), schemaId, position }).returning();
    await recordAudit(tx, actor, schemaId, "update", { [`schemaFields.${field.name}`]: { from: null, to: field } });
    return row!;
  });
}

/**
 * Only presentation and requiredness can change in place. Changing a field's type or target would
 * silently invalidate stored values, so that is modelled as archive-old + add-new instead.
 */
export async function updateSchemaField(
  db: Db,
  actor: Actor,
  schemaId: string,
  fieldId: string,
  patch: { displayName?: string; isRequired?: boolean; archived?: boolean },
) {
  return db.transaction(async (tx) => {
    const [before] = await tx
      .select()
      .from(schemaFields)
      .where(and(eq(schemaFields.id, fieldId), eq(schemaFields.schemaId, schemaId)));
    if (!before) throw new NotFoundError("Field", fieldId);
    const values = {
      ...(patch.displayName !== undefined && { displayName: requireName(patch.displayName, "Field display") }),
      ...(patch.isRequired !== undefined && { isRequired: patch.isRequired }),
      ...(patch.archived !== undefined && { archivedAt: patch.archived ? new Date() : null }),
    };
    const [after] = await tx.update(schemaFields).set(values).where(eq(schemaFields.id, fieldId)).returning();
    const changes = diff(before, after!, ["displayName", "isRequired", "archivedAt"]);
    if (Object.keys(changes).length) {
      await recordAudit(
        tx,
        actor,
        schemaId,
        "update",
        Object.fromEntries(Object.entries(changes).map(([k, v]) => [`schemaFields.${before.name}.${k}`, v])),
      );
    }
    return after!;
  });
}

export function toFieldDefinitions(schema: SchemaWithFields): FieldDefinition[] {
  return schema.fields;
}
