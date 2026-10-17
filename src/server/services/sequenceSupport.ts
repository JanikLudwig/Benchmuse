/**
 * Validation and normalisation for sequence-bearing entities, shared by the entity service and
 * the sequence tools.
 */

import type { BioFeature } from "@/bio/formats/types";
import { rangeLength } from "@/bio/range";
import { MAX_SEQUENCE_LENGTH, normalizeSequence, type SeqKind } from "@/bio/seq";
import { SEQUENCE_ENTITY_TYPES, type EntityType, type SequenceAnnotation } from "../db/schema";
import { newId } from "../domain/ids";
import { ValidationError } from "./errors";

/** Feature input as accepted by the API: segments, or a single start/end pair. */
export interface FeatureInput {
  id?: string;
  name: string;
  type?: string;
  strand?: number;
  segments?: { start: number; end: number }[];
  start?: number;
  end?: number;
  qualifiers?: Record<string, string[]>;
  color?: string;
  partial5?: boolean;
  partial3?: boolean;
}

export function isSequenceType(entityType: EntityType): boolean {
  return (SEQUENCE_ENTITY_TYPES as readonly string[]).includes(entityType);
}

export function sequenceKindOf(entityType: EntityType): SeqKind | null {
  if (entityType === "aa_sequence") return "aa";
  return isSequenceType(entityType) ? "dna" : null;
}

/** Only DNA molecules can be circular; oligos and proteins are always linear. */
export function canBeCircular(entityType: EntityType): boolean {
  return entityType === "dna_sequence" || entityType === "rna_sequence";
}

export function checkSequence(entityType: EntityType, sequence: string | undefined | null): string | null {
  const kind = sequenceKindOf(entityType);
  if (!kind) {
    if (sequence) throw new ValidationError("Custom entities do not have a sequence");
    return null;
  }
  const normalized = normalizeSequence(sequence ?? "", kind);
  if (!normalized.ok) throw new ValidationError(`Invalid sequence: ${normalized.error}`);
  if (normalized.value.length > MAX_SEQUENCE_LENGTH) {
    throw new ValidationError(`Sequences are limited to ${MAX_SEQUENCE_LENGTH.toLocaleString("en")} bases`);
  }
  return normalized.value;
}

const MAX_FEATURES = 5000;

/**
 * Validate features against a sequence and normalise them into the stored shape.
 *
 * A feature may be given either as `segments` (for joins and origin-spanning features) or as a
 * single `start`/`end` pair. Client-supplied ids are kept so editing a feature does not detach
 * comments or selections that reference it.
 */
export function checkFeatures(
  entityType: EntityType,
  input: readonly FeatureInput[] | undefined,
  sequence: string | null,
  isCircular: boolean,
): SequenceAnnotation[] {
  if (!input?.length) return [];
  if (sequence === null) throw new ValidationError("Only sequences can carry features");
  if (input.length > MAX_FEATURES) throw new ValidationError(`At most ${MAX_FEATURES} features per sequence`);

  const length = sequence.length;
  const circular = isCircular && canBeCircular(entityType);
  const errors: { field: string; message: string }[] = [];
  const seen = new Set<string>();
  const out: SequenceAnnotation[] = [];

  input.forEach((feature, i) => {
    const field = `features[${i}]`;
    const name = feature.name?.trim();
    if (!name) {
      errors.push({ field, message: "name is required" });
      return;
    }
    const segments = feature.segments?.length
      ? feature.segments
      : feature.start !== undefined && feature.end !== undefined
        ? [{ start: feature.start, end: feature.end }]
        : [];
    if (!segments.length) {
      errors.push({ field, message: "needs either segments or a start and end" });
      return;
    }
    for (const [j, segment] of segments.entries()) {
      const where = `${field}.segments[${j}]`;
      if (!Number.isInteger(segment.start) || !Number.isInteger(segment.end)) {
        errors.push({ field: where, message: "start and end must be integers" });
        continue;
      }
      if (segment.start < 0 || segment.start >= length) {
        errors.push({ field: where, message: `start ${segment.start} is outside the sequence (length ${length})` });
      }
      if (segment.end < 1 || segment.end > length) {
        errors.push({ field: where, message: `end ${segment.end} is outside the sequence (length ${length})` });
      }
      if (segment.end <= segment.start && !circular) {
        errors.push({ field: where, message: "end must be greater than start on a linear sequence" });
      }
      if (segment.end <= segment.start && circular && rangeLength(segment, length, true) === 0) {
        errors.push({ field: where, message: "segment is empty" });
      }
    }
    if (feature.strand !== undefined && ![1, -1, 0].includes(feature.strand)) {
      errors.push({ field, message: "strand must be 1, -1 or 0" });
    }
    if (feature.color && !/^#[0-9a-fA-F]{6}$/.test(feature.color)) {
      errors.push({ field, message: "color must be a hex value like #1e90ff" });
    }

    const id = feature.id && !seen.has(feature.id) ? feature.id : newId("annotation");
    seen.add(id);
    out.push({
      id,
      name: name.slice(0, 200),
      type: feature.type?.trim() || "misc_feature",
      strand: (feature.strand ?? 1) as 1 | -1 | 0,
      segments: segments.map((s) => ({ start: s.start, end: s.end })),
      ...(feature.qualifiers && Object.keys(feature.qualifiers).length ? { qualifiers: feature.qualifiers } : {}),
      ...(feature.color ? { color: feature.color.toLowerCase() } : {}),
      ...(feature.partial5 ? { partial5: true } : {}),
      ...(feature.partial3 ? { partial3: true } : {}),
    });
  });

  if (errors.length) throw new ValidationError("Invalid features", errors);
  return out;
}

/**
 * Stored features as the bio engine's feature type, keeping the stored id.
 *
 * The bio engine copies feature objects wholesale when it moves them, so the id rides along
 * through edits and the caller can write the result straight back.
 */
export function toBioFeatures(features: readonly SequenceAnnotation[]): (BioFeature & { id: string })[] {
  return features.map((f) => ({ ...f, qualifiers: f.qualifiers ?? {} }));
}

/** Narrow edited features back to the stored shape, giving any new ones an id. */
export function toStoredFeatures(features: readonly (BioFeature & { id?: string })[]): SequenceAnnotation[] {
  return features.map((f) => ({
    id: f.id ?? newId("annotation"),
    name: f.name,
    type: f.type,
    strand: f.strand,
    segments: f.segments.map((s) => ({ start: s.start, end: s.end })),
    ...(Object.keys(f.qualifiers ?? {}).length ? { qualifiers: f.qualifiers } : {}),
    ...(f.color && { color: f.color }),
    ...(f.partial5 && { partial5: f.partial5 }),
    ...(f.partial3 && { partial3: f.partial3 }),
  }));
}

/** Give imported features ids so they can be stored. */
export function fromBioFeatures(features: readonly BioFeature[]): SequenceAnnotation[] {
  return features.map((f) => ({
    id: newId("annotation"),
    name: f.name,
    type: f.type,
    strand: f.strand,
    segments: f.segments.map((s) => ({ start: s.start, end: s.end })),
    ...(Object.keys(f.qualifiers ?? {}).length ? { qualifiers: f.qualifiers } : {}),
    ...(f.color && { color: f.color }),
    ...(f.partial5 && { partial5: f.partial5 }),
    ...(f.partial3 && { partial3: f.partial3 }),
  }));
}
