import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";
import type { FieldType, FieldValues } from "../domain/fields";

export const ARCHIVE_REASONS = [
  "made_in_error",
  "retired",
  "expended",
  "shipped",
  "contaminated",
  "expired",
  "missing",
  "other",
] as const;
export type ArchiveReason = (typeof ARCHIVE_REASONS)[number];

export const SCHEMA_KINDS = ["entity", "entry", "result"] as const;
export type SchemaKind = (typeof SCHEMA_KINDS)[number];

export const ENTITY_TYPES = [
  "custom",
  "dna_sequence",
  "rna_sequence",
  "aa_sequence",
  /** a short synthetic oligonucleotide: primer, gBlock, guide RNA */
  "dna_oligo",
] as const;
export type EntityType = (typeof ENTITY_TYPES)[number];

/** Entity types that carry a nucleotide or protein sequence. */
export const SEQUENCE_ENTITY_TYPES = ["dna_sequence", "rna_sequence", "aa_sequence", "dna_oligo"] as const;

export const OLIGO_ROLES = ["primer", "guide_rna", "gblock", "probe", "adapter", "other"] as const;
export type OligoRole = (typeof OLIGO_ROLES)[number];

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });

/** Columns shared by every first-class object (Benchling's creator/archivable/searchable interfaces, designed in). */
const baseColumns = () => ({
  createdById: text("created_by_id")
    .notNull()
    .references(() => users.id),
  createdAt: ts("created_at").notNull().defaultNow(),
  modifiedAt: ts("modified_at").notNull().defaultNow(),
  archivedAt: ts("archived_at"),
  archiveReason: text("archive_reason", { enum: ARCHIVE_REASONS }),
});

export const USER_ROLES = ["admin", "member", "viewer"] as const;
export type UserRole = (typeof USER_ROLES)[number];

export const users = pgTable("users", {
  id: text("id").primaryKey(),
  handle: text("handle").notNull().unique(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  /** scrypt hash; null for accounts that may only sign in through an external provider */
  passwordHash: text("password_hash"),
  role: text("role", { enum: USER_ROLES }).notNull().default("member"),
  disabledAt: ts("disabled_at"),
  lastSeenAt: ts("last_seen_at"),
  createdAt: ts("created_at").notNull().defaultNow(),
});

/** A browser session, keyed by a hash of the cookie value so the raw token is never stored. */
export const sessions = pgTable(
  "sessions",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id),
    tokenHash: text("token_hash").notNull().unique(),
    expiresAt: ts("expires_at").notNull(),
    createdAt: ts("created_at").notNull().defaultNow(),
    lastUsedAt: ts("last_used_at").notNull().defaultNow(),
    userAgent: text("user_agent"),
  },
  (t) => [index("sessions_user_idx").on(t.userId)],
);

/** A long-lived token for scripts and instruments, shown once at creation. */
export const apiKeys = pgTable(
  "api_keys",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id),
    name: text("name").notNull(),
    tokenHash: text("token_hash").notNull().unique(),
    /** first characters of the token, so a key can be recognised in a list */
    prefix: text("prefix").notNull(),
    expiresAt: ts("expires_at"),
    lastUsedAt: ts("last_used_at"),
    revokedAt: ts("revoked_at"),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [index("api_keys_user_idx").on(t.userId)],
);

export const projects = pgTable("projects", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  description: text("description").notNull().default(""),
  ...baseColumns(),
});

export const folders = pgTable(
  "folders",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id),
    /** null = the project's root folder (exactly one per project, created with the project) */
    parentFolderId: text("parent_folder_id").references((): AnyPgColumn => folders.id),
    name: text("name").notNull(),
    ...baseColumns(),
  },
  (t) => [
    index("folders_project_idx").on(t.projectId),
    index("folders_parent_idx").on(t.parentFolderId),
    uniqueIndex("folders_one_root_per_project_uq").on(t.projectId).where(sql`${t.parentFolderId} is null`),
  ],
);

export const dropdowns = pgTable("dropdowns", {
  id: text("id").primaryKey(),
  name: text("name").notNull().unique(),
  ...baseColumns(),
});

export const dropdownOptions = pgTable(
  "dropdown_options",
  {
    id: text("id").primaryKey(),
    dropdownId: text("dropdown_id")
      .notNull()
      .references(() => dropdowns.id),
    name: text("name").notNull(),
    position: integer("position").notNull(),
    archivedAt: ts("archived_at"),
  },
  (t) => [uniqueIndex("dropdown_options_name_uq").on(t.dropdownId, t.name)],
);

export const schemas = pgTable("schemas", {
  id: text("id").primaryKey(),
  kind: text("kind", { enum: SCHEMA_KINDS }).notNull(),
  name: text("name").notNull().unique(),
  description: text("description").notNull().default(""),
  /** entity schemas only: what kind of entity instances are */
  entityType: text("entity_type", { enum: ENTITY_TYPES }),
  /** entity schemas only: registry ID template, e.g. `PLS-{n:4}`; null = cannot be registered */
  nameTemplate: text("name_template"),
  /** next value of the template's {n} counter; incremented atomically on registration */
  nextNumber: integer("next_number").notNull().default(1),
  ...baseColumns(),
});

export const schemaFields = pgTable(
  "schema_fields",
  {
    id: text("id").primaryKey(),
    schemaId: text("schema_id")
      .notNull()
      .references(() => schemas.id),
    name: text("name").notNull(),
    displayName: text("display_name").notNull(),
    type: text("type").$type<FieldType>().notNull(),
    isRequired: boolean("is_required").notNull().default(false),
    isMulti: boolean("is_multi").notNull().default(false),
    dropdownId: text("dropdown_id").references(() => dropdowns.id),
    targetSchemaId: text("target_schema_id").references(() => schemas.id),
    position: integer("position").notNull(),
    createdAt: ts("created_at").notNull().defaultNow(),
    archivedAt: ts("archived_at"),
  },
  (t) => [uniqueIndex("schema_fields_name_uq").on(t.schemaId, t.name)],
);

/**
 * A sequence feature as stored on an entity.
 *
 * `segments` holds one entry for a simple feature and several for a join (exons, or a feature
 * crossing the origin of a plasmid), matching GenBank semantics and `BioFeature` in src/bio.
 */
export interface SequenceAnnotation {
  id: string;
  name: string;
  type: string;
  strand: 1 | -1 | 0;
  segments: { start: number; end: number }[];
  qualifiers?: Record<string, string[]>;
  color?: string;
  partial5?: boolean;
  partial3?: boolean;
}

export const entities = pgTable(
  "entities",
  {
    id: text("id").primaryKey(),
    schemaId: text("schema_id").references(() => schemas.id),
    entityType: text("entity_type", { enum: ENTITY_TYPES }).notNull(),
    name: text("name").notNull(),
    folderId: text("folder_id")
      .notNull()
      .references(() => folders.id),
    registryId: text("registry_id").unique(),
    registeredAt: ts("registered_at"),
    fields: jsonb("fields").$type<FieldValues>().notNull().default({}),
    aliases: text("aliases").array().notNull().default(sql`'{}'::text[]`),
    /** dna_sequence: IUPAC bases; aa_sequence: amino acids */
    sequence: text("sequence"),
    isCircular: boolean("is_circular").notNull().default(false),
    features: jsonb("features").$type<SequenceAnnotation[]>().notNull().default([]),
    /** per-base phred scores, when the sequence came from a chromatogram */
    qualities: jsonb("qualities").$type<number[] | null>(),
    /** dna_oligo only: what the oligo is for */
    oligoRole: text("oligo_role", { enum: OLIGO_ROLES }),
    /** file this entity was imported from, if any */
    sourceFileId: text("source_file_id").references((): AnyPgColumn => files.id),
    ...baseColumns(),
  },
  (t) => [
    index("entities_folder_idx").on(t.folderId),
    index("entities_schema_idx").on(t.schemaId),
    index("entities_fields_gin").using("gin", t.fields),
  ],
);

export const entries = pgTable(
  "entries",
  {
    id: text("id").primaryKey(),
    schemaId: text("schema_id").references(() => schemas.id),
    name: text("name").notNull(),
    folderId: text("folder_id")
      .notNull()
      .references(() => folders.id),
    fields: jsonb("fields").$type<FieldValues>().notNull().default({}),
    /** rich document (Tiptap/ProseMirror JSON) */
    content: jsonb("content").$type<Record<string, unknown>>().notNull().default({ type: "doc", content: [] }),
    ...baseColumns(),
  },
  (t) => [index("entries_folder_idx").on(t.folderId)],
);

export const results = pgTable(
  "results",
  {
    id: text("id").primaryKey(),
    schemaId: text("schema_id")
      .notNull()
      .references(() => schemas.id),
    entryId: text("entry_id").references(() => entries.id),
    /** insertion order: rows created in one transaction share created_at, but must keep table order */
    seq: bigint("seq", { mode: "number" }).generatedAlwaysAsIdentity(),
    fields: jsonb("fields").$type<FieldValues>().notNull().default({}),
    ...baseColumns(),
  },
  (t) => [index("results_schema_idx").on(t.schemaId), index("results_entry_idx").on(t.entryId, t.seq)],
);

export const AUDIT_ACTIONS = ["create", "update", "archive", "unarchive", "register", "move"] as const;
export type AuditAction = (typeof AUDIT_ACTIONS)[number];

export type AuditChanges = Record<string, { from: unknown; to: unknown }>;

export const auditEvents = pgTable(
  "audit_events",
  {
    id: text("id").primaryKey(),
    objectId: text("object_id").notNull(),
    action: text("action", { enum: AUDIT_ACTIONS }).notNull(),
    actorId: text("actor_id")
      .notNull()
      .references(() => users.id),
    at: ts("at").notNull().defaultNow(),
    changes: jsonb("changes").$type<AuditChanges>().notNull().default({}),
  },
  (t) => [index("audit_events_object_idx").on(t.objectId, t.at)],
);

// ---------------------------------------------------------------------------------------------
// Files

/**
 * An uploaded file. Content is addressed by SHA-256 and held by the blob store, so the same
 * file uploaded twice is stored once.
 */
export const files = pgTable(
  "files",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    contentType: text("content_type").notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    sha256: text("sha256").notNull(),
    /** folder the file is filed under, when it was uploaded into a project */
    folderId: text("folder_id").references(() => folders.id),
    /** what the importer made of it: genbank, fasta, ab1, other */
    detectedFormat: text("detected_format"),
    ...baseColumns(),
  },
  (t) => [index("files_sha_idx").on(t.sha256), index("files_folder_idx").on(t.folderId)],
);

// ---------------------------------------------------------------------------------------------
// Sequence alignments

export const ALIGNMENT_KINDS = ["sanger", "pairwise", "multiple"] as const;
export type AlignmentKind = (typeof ALIGNMENT_KINDS)[number];

export const alignments = pgTable(
  "alignments",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    kind: text("kind", { enum: ALIGNMENT_KINDS }).notNull().default("sanger"),
    /** the sequence everything was aligned to */
    referenceEntityId: text("reference_entity_id")
      .notNull()
      .references(() => entities.id),
    folderId: text("folder_id").references(() => folders.id),
    /** scoring and trimming settings used, so a run can be reproduced */
    settings: jsonb("settings").$type<Record<string, unknown>>().notNull().default({}),
    ...baseColumns(),
  },
  (t) => [index("alignments_reference_idx").on(t.referenceEntityId)],
);

export interface StoredVariant {
  type: "substitution" | "insertion" | "deletion";
  refStart: number;
  refEnd: number;
  refBases: string;
  queryBases: string;
  queryPosition: number;
  quality?: number;
  label: string;
  effects: { featureName: string; consequence: string; aaPosition?: number; codonChange?: string; proteinChange?: string }[];
}

export interface StoredCigar {
  op: "M" | "I" | "D";
  length: number;
}

/** One read placed against the alignment's reference. */
export const alignmentReads = pgTable(
  "alignment_reads",
  {
    id: text("id").primaryKey(),
    alignmentId: text("alignment_id")
      .notNull()
      .references(() => alignments.id),
    name: text("name").notNull(),
    /** the chromatogram or FASTA this read came from */
    fileId: text("file_id").references(() => files.id),
    /** read as supplied, before trimming */
    sequence: text("sequence").notNull(),
    qualities: jsonb("qualities").$type<number[] | null>(),
    /** region of the read kept after quality trimming */
    trimStart: integer("trim_start").notNull().default(0),
    trimEnd: integer("trim_end").notNull().default(0),
    /** 1 if the read aligned as given, -1 if its reverse complement did, 0 if it did not align */
    strand: integer("strand").notNull().default(0),
    refStart: integer("ref_start"),
    refEnd: integer("ref_end"),
    identity: integer("identity_percent"),
    cigar: jsonb("cigar").$type<StoredCigar[]>().notNull().default([]),
    variants: jsonb("variants").$type<StoredVariant[]>().notNull().default([]),
    /** why a read could not be placed, when it could not */
    failureReason: text("failure_reason"),
    seq: bigint("seq", { mode: "number" }).generatedAlwaysAsIdentity(),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [index("alignment_reads_alignment_idx").on(t.alignmentId, t.seq)],
);

// ---------------------------------------------------------------------------------------------
// Construct lineage

export const CONSTRUCT_METHODS = [
  "restriction_ligation",
  "gibson",
  "golden_gate",
  "pcr",
  "mutagenesis",
  "synthesis",
  "manual_edit",
  "import",
] as const;
export type ConstructMethod = (typeof CONSTRUCT_METHODS)[number];

/**
 * Records that one entity was made from others, and how. This is what lets a scientist ask
 * "where did this plasmid come from?" months later.
 */
export const lineage = pgTable(
  "lineage",
  {
    id: text("id").primaryKey(),
    childEntityId: text("child_entity_id")
      .notNull()
      .references(() => entities.id),
    parentEntityId: text("parent_entity_id").references(() => entities.id),
    method: text("method", { enum: CONSTRUCT_METHODS }).notNull(),
    /** the role this parent played: backbone, insert, template, primer… */
    role: text("role"),
    /** enzymes, overlaps, primers, junctions — whatever the method needs to be reproducible */
    details: jsonb("details").$type<Record<string, unknown>>().notNull().default({}),
    createdById: text("created_by_id")
      .notNull()
      .references(() => users.id),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [index("lineage_child_idx").on(t.childEntityId), index("lineage_parent_idx").on(t.parentEntityId)],
);

// ---------------------------------------------------------------------------------------------
// Notebook data tables

export const TABLE_COLUMN_TYPES = ["text", "number", "date", "checkbox", "select", "entity", "formula"] as const;
export type TableColumnType = (typeof TABLE_COLUMN_TYPES)[number];

export interface TableColumn {
  id: string;
  name: string;
  type: TableColumnType;
  /** shown after the name and in calculations, e.g. "µL", "ng/µL", "mM" */
  unit?: string;
  width?: number;
  /** for select columns */
  options?: string[];
  /** decimal places for number columns */
  decimals?: number;
}

/**
 * A spreadsheet embedded in a notebook entry.
 *
 * Cells hold raw text exactly as typed, as a spreadsheet does: anything starting with `=` is a
 * formula, evaluated on read. Rows are stored row-major so cell references line up with the
 * grid the scientist sees.
 */
export const notebookTables = pgTable(
  "notebook_tables",
  {
    id: text("id").primaryKey(),
    entryId: text("entry_id")
      .notNull()
      .references(() => entries.id),
    name: text("name").notNull().default("Table"),
    columns: jsonb("columns").$type<TableColumn[]>().notNull().default([]),
    rows: jsonb("rows").$type<string[][]>().notNull().default([]),
    ...baseColumns(),
  },
  (t) => [index("notebook_tables_entry_idx").on(t.entryId)],
);
