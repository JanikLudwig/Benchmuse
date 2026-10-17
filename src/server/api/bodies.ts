/** Request body shapes for the v1 API. Business rules live in services; these only check structure. */
import { z } from "zod";
import { ARCHIVE_REASONS, ENTITY_TYPES, SCHEMA_KINDS } from "../db/schema";
import { FIELD_TYPES } from "../domain/fields";

const name = z.string().max(200);
const fieldValues = z.record(z.string(), z.unknown());

export const createProjectBody = z.object({ name, description: z.string().max(5000).optional() });
export const updateProjectBody = createProjectBody.partial();

export const createFolderBody = z.object({
  name,
  projectId: z.string().optional(),
  parentFolderId: z.string().optional(),
});
export const moveBody = z.object({ folderId: z.string() });

const fieldInput = z.object({
  name: z.string(),
  displayName: z.string(),
  type: z.enum(FIELD_TYPES),
  isRequired: z.boolean().optional(),
  isMulti: z.boolean().optional(),
  dropdownId: z.string().nullish(),
  targetSchemaId: z.string().nullish(),
});
export const createSchemaBody = z.object({
  kind: z.enum(SCHEMA_KINDS),
  name,
  description: z.string().max(5000).optional(),
  entityType: z.enum(ENTITY_TYPES).optional(),
  nameTemplate: z.string().nullish(),
  fields: z.array(fieldInput).max(200).optional(),
});
export const updateSchemaBody = z.object({
  name: name.optional(),
  description: z.string().max(5000).optional(),
  nameTemplate: z.string().nullish(),
});
export const addFieldBody = fieldInput;
export const updateFieldBody = z.object({
  displayName: z.string().optional(),
  isRequired: z.boolean().optional(),
  archived: z.boolean().optional(),
});

export const createDropdownBody = z.object({ name, options: z.array(z.string()).max(1000) });
export const addOptionBody = z.object({ name });

const annotation = z.object({
  id: z.string().optional(),
  name: z.string(),
  start: z.number().int(),
  end: z.number().int(),
  strand: z.number().int().optional(),
  type: z.string().optional(),
  color: z.string().optional(),
});
export const createEntityBody = z.object({
  name,
  folderId: z.string(),
  schemaId: z.string().nullish(),
  entityType: z.enum(ENTITY_TYPES).optional(),
  fields: fieldValues.optional(),
  aliases: z.array(z.string()).max(100).optional(),
  sequence: z.string().optional(),
  isCircular: z.boolean().optional(),
  annotations: z.array(annotation).max(5000).optional(),
});
export const updateEntityBody = createEntityBody.omit({ folderId: true, schemaId: true, entityType: true }).partial();

export const createEntryBody = z.object({
  name,
  folderId: z.string(),
  schemaId: z.string().nullish(),
  fields: fieldValues.optional(),
  content: z.unknown().optional(),
});
export const updateEntryBody = z.object({ name: name.optional(), fields: fieldValues.optional(), content: z.unknown().optional() });

export const createResultsBody = z.object({
  schemaId: z.string(),
  entryId: z.string().nullish(),
  rows: z.array(fieldValues).min(1).max(1000),
});

export const archiveBody = z.object({ ids: z.array(z.string()).min(1).max(1000), reason: z.enum(ARCHIVE_REASONS) });
export const unarchiveBody = z.object({ ids: z.array(z.string()).min(1).max(1000) });
