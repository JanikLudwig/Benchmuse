/**
 * Importing sequence files into the registry, and exporting entities back out.
 *
 * Import is deliberately two-phase: `previewImport` parses and reports what was found without
 * writing anything, and `commitImport` creates the entities. That lets the UI show a scientist
 * exactly what will be created — and any warnings — before anything lands in their project.
 */

import { parseAb1, chromatogramToRecord, trimByQuality } from "@/bio/formats/ab1";
import { parseFasta, writeFasta } from "@/bio/formats/fasta";
import { parseGenBank, writeGenBank } from "@/bio/formats/genbank";
import type { ParseWarning, SequenceRecord } from "@/bio/formats/types";
import { suggestAnnotations } from "@/bio/features/annotate";
import type { Db } from "../db/client";
import type { EntityType, OligoRole } from "../db/schema";
import type { Actor } from "./audit";
import { createEntity, getEntity } from "./entities";
import { ValidationError } from "./errors";
import { readFileBytes } from "./files";
import { fromBioFeatures, toBioFeatures } from "./sequenceSupport";
import { recordLineage } from "./lineage";

export interface ImportCandidate {
  /** index of this record within the file */
  index: number;
  name: string;
  description?: string;
  entityType: EntityType;
  length: number;
  isCircular: boolean;
  featureCount: number;
  /** first 60 bases, for the preview table */
  preview: string;
  /** set for AB1 reads */
  meanQuality?: number;
  trimmedLength?: number;
}

export interface ImportPreview {
  fileId: string;
  fileName: string;
  format: string;
  candidates: ImportCandidate[];
  warnings: string[];
}

const OLIGO_MAX_LENGTH = 120;

/** Decide what kind of entity a parsed record should become. */
export function entityTypeFor(record: SequenceRecord): EntityType {
  if (record.kind === "aa") return "aa_sequence";
  if (record.format === "ab1") return "dna_sequence";
  // Short synthetic sequences with no features are almost always oligos.
  if (record.residues.length <= OLIGO_MAX_LENGTH && !record.features.length && !record.isCircular) return "dna_oligo";
  if (/\bRNA\b/i.test(record.description ?? "") || /^[ACGUN]+$/i.test(record.residues)) {
    return /U/i.test(record.residues) ? "rna_sequence" : "dna_sequence";
  }
  return "dna_sequence";
}

/** Parse a stored file into sequence records without writing anything. */
export async function parseStoredFile(db: Db, fileId: string): Promise<{ records: SequenceRecord[]; warnings: ParseWarning[]; format: string; fileName: string }> {
  const { file, bytes } = await readFileBytes(db, fileId);
  const format = file.detectedFormat ?? "text";

  if (format === "ab1") {
    const { chromatogram, warnings } = parseAb1(bytes);
    if (!chromatogram) return { records: [], warnings, format, fileName: file.name };
    return { records: [chromatogramToRecord(chromatogram, stripExtension(file.name))], warnings, format, fileName: file.name };
  }

  const text = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  if (format === "genbank") {
    const { records, warnings } = parseGenBank(text);
    return { records, warnings, format, fileName: file.name };
  }
  if (format === "fasta") {
    const { records, warnings } = parseFasta(text);
    return { records, warnings, format, fileName: file.name };
  }
  // Fall back to sniffing the content, so a mislabelled file still imports.
  const genbank = parseGenBank(text);
  if (genbank.records.some((r) => r.residues.length)) return { ...genbank, format: "genbank", fileName: file.name };
  const fasta = parseFasta(text);
  if (fasta.records.some((r) => r.residues.length)) return { ...fasta, format: "fasta", fileName: file.name };
  return { records: [], warnings: [{ message: `No sequences found in ${file.name}` }], format, fileName: file.name };
}

export async function previewImport(db: Db, fileId: string): Promise<ImportPreview> {
  const { records, warnings, format, fileName } = await parseStoredFile(db, fileId);
  return {
    fileId,
    fileName,
    format,
    warnings: warnings.map((w) => (w.line ? `Line ${w.line}: ${w.message}` : w.message)),
    candidates: records.map((record, index) => {
      const trimmed = record.qualities ? trimByQuality(record.residues, record.qualities) : null;
      return {
        index,
        name: record.name,
        ...(record.description && { description: record.description }),
        entityType: entityTypeFor(record),
        length: record.residues.length,
        isCircular: record.isCircular,
        featureCount: record.features.length,
        preview: record.residues.slice(0, 60),
        ...(record.qualities?.length && {
          meanQuality: Math.round((record.qualities.reduce((a, b) => a + b, 0) / record.qualities.length) * 10) / 10,
          trimmedLength: trimmed?.trimmedSequence.length ?? 0,
        }),
      };
    }),
  };
}

export interface CommitImportInput {
  fileId: string;
  folderId: string;
  /** which records to import; all of them when omitted */
  indexes?: number[];
  /** override the name of each record, keyed by index */
  names?: Record<number, string>;
  /** attach every imported entity to this schema */
  schemaId?: string | null;
  /** run the parts library over imported sequences and add what it finds */
  autoAnnotate?: boolean;
  /** override the inferred entity type */
  entityType?: EntityType;
  oligoRole?: OligoRole;
}

export async function commitImport(db: Db, actor: Actor, input: CommitImportInput) {
  const { records } = await parseStoredFile(db, input.fileId);
  if (!records.length) throw new ValidationError("This file contains no sequences to import");

  const wanted = input.indexes?.length ? input.indexes : records.map((_, i) => i);
  const invalid = wanted.filter((i) => i < 0 || i >= records.length);
  if (invalid.length) throw new ValidationError(`No record at index ${invalid.join(", ")} in this file`);

  const created = [];
  for (const index of wanted) {
    const record = records[index]!;
    const entityType = input.entityType ?? entityTypeFor(record);
    const isCircular = record.isCircular && (entityType === "dna_sequence" || entityType === "rna_sequence");

    let features = fromBioFeatures(record.features);
    if (input.autoAnnotate && record.residues.length) {
      const suggestions = suggestAnnotations(record.residues, isCircular, { existing: record.features });
      features = [...features, ...fromBioFeatures(suggestions)];
    }

    const entity = await createEntity(db, actor, {
      name: (input.names?.[index] ?? record.name).slice(0, 200),
      folderId: input.folderId,
      schemaId: input.schemaId ?? null,
      entityType,
      sequence: record.residues,
      isCircular,
      features,
      sourceFileId: input.fileId,
      ...(record.qualities && { qualities: record.qualities }),
      ...(entityType === "dna_oligo" && { oligoRole: input.oligoRole ?? "primer" }),
    });
    await recordLineage(db, actor, {
      childEntityId: entity.id,
      method: "import",
      details: { fileId: input.fileId, recordIndex: index, format: record.format },
    });
    created.push(entity);
  }
  return created;
}

// ---------------------------------------------------------------------------------------------
// Export

export type ExportFormat = "genbank" | "fasta";

/** Render a stored entity in an interchange format. */
export async function exportEntity(db: Db, entityId: string, format: ExportFormat): Promise<{ filename: string; contentType: string; body: string }> {
  const entity = await getEntity(db, entityId);
  if (!entity.sequence) throw new ValidationError("This entity has no sequence to export");

  const record: SequenceRecord = {
    name: entity.registryId ?? entity.name,
    description: entity.name,
    kind: entity.entityType === "aa_sequence" ? "aa" : "dna",
    isCircular: entity.isCircular,
    residues: entity.sequence,
    features: toBioFeatures(entity.features),
    format: "genbank",
  };

  const safeName = (entity.registryId ?? entity.name).replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 80) || "sequence";
  if (format === "fasta") {
    return { filename: `${safeName}.fasta`, contentType: "application/x-fasta", body: writeFasta(record) };
  }
  return { filename: `${safeName}.gb`, contentType: "chemical/seq-na-genbank", body: writeGenBank(record) };
}

function stripExtension(name: string): string {
  return name.replace(/\.[^.]+$/, "") || name;
}

/** Create a sequence entity straight from pasted text rather than an uploaded file. */
export async function importPastedSequence(
  db: Db,
  actor: Actor,
  input: { text: string; name?: string; folderId: string; schemaId?: string | null; autoAnnotate?: boolean },
) {
  const text = input.text.trim();
  if (!text) throw new ValidationError("Nothing to import");

  const genbank = parseGenBank(text);
  const records = genbank.records.some((r) => r.residues.length) ? genbank.records : parseFasta(text).records;
  const record = records[0];
  if (!record?.residues.length) {
    // Plain bases with no header at all.
    const bare = text.replace(/[^A-Za-z*-]/g, "");
    if (!bare) throw new ValidationError("No sequence found in the pasted text");
    return [
      await createEntity(db, actor, {
        name: input.name?.trim() || "Pasted sequence",
        folderId: input.folderId,
        schemaId: input.schemaId ?? null,
        entityType: bare.length <= OLIGO_MAX_LENGTH ? "dna_oligo" : "dna_sequence",
        sequence: bare,
        ...(bare.length <= OLIGO_MAX_LENGTH && { oligoRole: "primer" as const }),
      }),
    ];
  }

  const entityType = entityTypeFor(record);
  const isCircular = record.isCircular && (entityType === "dna_sequence" || entityType === "rna_sequence");
  let features = fromBioFeatures(record.features);
  if (input.autoAnnotate) {
    features = [...features, ...fromBioFeatures(suggestAnnotations(record.residues, isCircular, { existing: record.features }))];
  }
  return [
    await createEntity(db, actor, {
      name: input.name?.trim() || record.name,
      folderId: input.folderId,
      schemaId: input.schemaId ?? null,
      entityType,
      sequence: record.residues,
      isCircular,
      features,
    }),
  ];
}
