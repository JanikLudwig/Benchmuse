/**
 * Sequencing alignments: place reads against a reference sequence, call the differences, and
 * keep the result so a scientist can come back to it.
 *
 * This is the "I got my Sanger results back" workflow: upload the .ab1 files, pick the plasmid
 * they should match, and see exactly where they differ and what those differences do.
 */

import { alignRead, cigarString, DNA_SCORING, type ScoringScheme } from "@/bio/align";
import { parseAb1, trimByQuality, type Chromatogram } from "@/bio/formats/ab1";
import { parseFasta } from "@/bio/formats/fasta";
import { parseGenBank } from "@/bio/formats/genbank";
import { withDefaults } from "@/bio/options";
import { callVariants, summarizeVariants, type Variant } from "@/bio/variants";
import { and, asc, desc, eq, inArray } from "drizzle-orm";
import type { Db } from "../db/client";
import { alignmentReads, alignments, entities, files, type StoredVariant } from "../db/schema";
import { newId } from "../domain/ids";
import { recordAudit, type Actor } from "./audit";
import { NotFoundError, ValidationError } from "./errors";
import { readFileBytes } from "./files";
import { getWritableFolder } from "./projects";
import { getSequenceEntity } from "./sequenceTools";
import { toBioFeatures } from "./sequenceSupport";

export interface AlignmentSettings {
  /** phred score below which read ends are trimmed (0 disables trimming) */
  trimQuality?: number;
  /** ignore differences whose base call is poorer than this */
  minVariantQuality?: number;
  scoring?: Partial<ScoringScheme>;
}

export const DEFAULT_SETTINGS: Required<Omit<AlignmentSettings, "scoring">> & { scoring: ScoringScheme } = {
  trimQuality: 20,
  minVariantQuality: 20,
  scoring: DNA_SCORING,
};

export interface ReadInput {
  name: string;
  /** supply either a stored file to parse, or the bases directly */
  fileId?: string;
  sequence?: string;
  qualities?: number[];
}

export interface CreateAlignmentInput {
  name: string;
  referenceEntityId: string;
  folderId?: string | null;
  reads: ReadInput[];
  settings?: AlignmentSettings;
}

/**
 * Create an alignment and place every read against the reference.
 *
 * Reads that cannot be placed are kept with a reason rather than dropped, because "this read
 * did not match" is itself a result worth seeing.
 */
export async function createAlignment(db: Db, actor: Actor, input: CreateAlignmentInput) {
  const name = input.name?.trim();
  if (!name) throw new ValidationError("Alignment name is required");
  if (!input.reads.length) throw new ValidationError("Add at least one read to align");
  if (input.reads.length > 96) throw new ValidationError("At most 96 reads per alignment");

  const reference = await getSequenceEntity(db, input.referenceEntityId);
  if (input.folderId) await getWritableFolder(db, input.folderId);

  const settings = {
    ...withDefaults(DEFAULT_SETTINGS, input.settings as Partial<typeof DEFAULT_SETTINGS>),
    scoring: withDefaults(DNA_SCORING, input.settings?.scoring),
  };
  const referenceFeatures = toBioFeatures(reference.features);

  // Resolve every read's bases before writing anything, so a bad file fails the whole request.
  const resolved: (ResolvedRead & { input: ReadInput })[] = [];
  for (const read of input.reads) {
    resolved.push({ input: read, ...(await resolveRead(db, read)) });
  }

  return db.transaction(async (tx) => {
    const [alignment] = await tx
      .insert(alignments)
      .values({
        id: newId("alignment"),
        name,
        kind: "sanger",
        referenceEntityId: reference.id,
        folderId: input.folderId ?? null,
        settings: settings as unknown as Record<string, unknown>,
        createdById: actor.id,
      })
      .returning();

    const rows = [];
    for (const read of resolved) {
      const placed = placeRead(reference.sequence, reference.isCircular, referenceFeatures, read, settings);
      rows.push({
        id: newId("read"),
        alignmentId: alignment!.id,
        name: read.input.name.trim().slice(0, 200) || read.name,
        fileId: read.input.fileId ?? null,
        sequence: read.sequence,
        qualities: read.qualities ?? null,
        ...placed,
      });
    }
    const inserted = rows.length ? await tx.insert(alignmentReads).values(rows).returning() : [];
    await recordAudit(tx, actor, alignment!.id, "create", {
      name: { from: null, to: name },
      reads: { from: null, to: inserted.length },
    });
    return { alignment: alignment!, reads: inserted };
  });
}

interface ResolvedRead {
  name: string;
  sequence: string;
  qualities?: number[];
  chromatogram?: Chromatogram;
}

async function resolveRead(db: Db, read: ReadInput): Promise<ResolvedRead> {
  if (read.sequence) {
    const bases = read.sequence.replace(/[^A-Za-z]/g, "").toUpperCase();
    if (bases.length < 20) throw new ValidationError(`Read "${read.name}" is too short to align`);
    return { name: read.name, sequence: bases, ...(read.qualities && { qualities: read.qualities }) };
  }
  if (!read.fileId) throw new ValidationError(`Read "${read.name}" has neither a file nor a sequence`);

  const { file, bytes } = await readFileBytes(db, read.fileId);
  if (file.detectedFormat === "ab1") {
    const { chromatogram } = parseAb1(bytes);
    if (!chromatogram) throw new ValidationError(`${file.name} could not be read as a chromatogram`);
    return {
      name: chromatogram.sampleName || file.name,
      sequence: chromatogram.sequence,
      qualities: chromatogram.qualities,
      chromatogram,
    };
  }
  const text = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  const parsed = file.detectedFormat === "genbank" ? parseGenBank(text) : parseFasta(text);
  const record = parsed.records[0];
  if (!record?.residues) throw new ValidationError(`No sequence found in ${file.name}`);
  return { name: record.name, sequence: record.residues.toUpperCase(), ...(record.qualities && { qualities: record.qualities }) };
}

type PlacedRead = Pick<
  typeof alignmentReads.$inferInsert,
  "trimStart" | "trimEnd" | "strand" | "refStart" | "refEnd" | "identity" | "cigar" | "variants" | "failureReason"
>;

function placeRead(
  reference: string,
  isCircular: boolean,
  referenceFeatures: ReturnType<typeof toBioFeatures>,
  read: { sequence: string; qualities?: number[] },
  settings: typeof DEFAULT_SETTINGS,
): PlacedRead {
  // Trim the noisy ends first; aligning untrimmed Sanger ends produces spurious differences.
  const trimmed =
    settings.trimQuality > 0 && read.qualities?.length
      ? trimByQuality(read.sequence, read.qualities, settings.trimQuality)
      : { start: 0, end: read.sequence.length, trimmedSequence: read.sequence, trimmedQualities: read.qualities ?? [] };

  if (trimmed.trimmedSequence.length < 20) {
    return {
      trimStart: trimmed.start,
      trimEnd: trimmed.end,
      strand: 0,
      refStart: null,
      refEnd: null,
      identity: null,
      cigar: [],
      variants: [],
      failureReason: "Too little good-quality sequence after trimming",
    };
  }

  const alignment = alignRead(reference, trimmed.trimmedSequence, isCircular, { scoring: settings.scoring });
  if (!alignment || alignment.identity < 0.7) {
    return {
      trimStart: trimmed.start,
      trimEnd: trimmed.end,
      strand: 0,
      refStart: null,
      refEnd: null,
      identity: alignment ? Math.round(alignment.identity * 100) : null,
      cigar: [],
      variants: [],
      failureReason: alignment
        ? `Best alignment is only ${(alignment.identity * 100).toFixed(0)}% identical; this read probably comes from a different template`
        : "The read does not match this reference",
    };
  }

  // Quality scores follow the read into its aligned orientation.
  const orientedQualities = orientQualities(trimmed.trimmedQualities, alignment.strand);
  const variants = callVariants(reference, alignment, {
    features: referenceFeatures,
    qualities: orientedQualities,
    minQuality: settings.minVariantQuality,
    referenceLength: reference.length,
    isCircular,
  });

  return {
    trimStart: trimmed.start,
    trimEnd: trimmed.end,
    strand: alignment.strand,
    refStart: alignment.refStartOnReference,
    refEnd: alignment.refEndOnReference,
    identity: Math.round(alignment.identity * 100),
    cigar: alignment.cigar,
    variants: variants as StoredVariant[],
    failureReason: null,
  };
}

function orientQualities(qualities: readonly number[], strand: 1 | -1): number[] {
  return strand === 1 ? [...qualities] : [...qualities].reverse();
}

// ---------------------------------------------------------------------------------------------
// Reading alignments back

export async function getAlignment(db: Db, id: string) {
  const [alignment] = await db.select().from(alignments).where(eq(alignments.id, id));
  if (!alignment) throw new NotFoundError("Alignment", id);
  const reads = await db
    .select()
    .from(alignmentReads)
    .where(eq(alignmentReads.alignmentId, id))
    .orderBy(asc(alignmentReads.seq));
  const [reference] = await db.select().from(entities).where(eq(entities.id, alignment.referenceEntityId));
  return { alignment, reads, reference: reference ?? null };
}

/** Everything the alignment viewer needs in one call. */
export async function getAlignmentView(db: Db, id: string) {
  const { alignment, reads, reference } = await getAlignment(db, id);
  if (!reference?.sequence) throw new NotFoundError("Reference sequence for alignment", id);

  const placed = reads.filter((r) => r.strand !== 0);
  const allVariants = placed.flatMap((r) => r.variants.map((v) => ({ ...v, readId: r.id, readName: r.name })));

  // A difference seen in every read covering that position is a real change to the construct;
  // one seen in a single read of several is more likely a sequencing artefact.
  const coverageAt = (position: number) =>
    placed.filter((r) => r.refStart !== null && r.refEnd !== null && withinRead(position, r.refStart, r.refEnd, reference.isCircular, reference.sequence!.length)).length;

  const byPosition = new Map<string, { variant: StoredVariant; readIds: string[]; readNames: string[] }>();
  for (const v of allVariants) {
    const key = `${v.type}:${v.refStart}:${v.refBases}:${v.queryBases}`;
    const entry = byPosition.get(key) ?? { variant: v, readIds: [], readNames: [] };
    entry.readIds.push(v.readId);
    entry.readNames.push(v.readName);
    byPosition.set(key, entry);
  }

  const consensusVariants = [...byPosition.values()]
    .map((entry) => ({
      ...entry.variant,
      readIds: entry.readIds,
      readNames: entry.readNames,
      supportingReads: entry.readIds.length,
      coveringReads: coverageAt(entry.variant.refStart),
      /** supported by every read that covers the position */
      confirmed: entry.readIds.length >= Math.max(1, coverageAt(entry.variant.refStart)),
    }))
    .sort((a, b) => a.refStart - b.refStart);

  return {
    alignment,
    reference: {
      id: reference.id,
      name: reference.name,
      registryId: reference.registryId,
      length: reference.sequence.length,
      isCircular: reference.isCircular,
      sequence: reference.sequence,
      features: reference.features,
    },
    reads: reads.map((r) => ({
      ...r,
      cigarString: cigarString(r.cigar),
      trimmedLength: Math.max(0, r.trimEnd - r.trimStart),
      variantCount: r.variants.length,
    })),
    variants: consensusVariants,
    summary: {
      total: reads.length,
      placed: placed.length,
      failed: reads.length - placed.length,
      distinctVariants: consensusVariants.length,
      confirmedVariants: consensusVariants.filter((v) => v.confirmed).length,
      consequences: summarizeVariants(consensusVariants as unknown as Variant[]),
      /** fraction of the reference covered by at least one read */
      coverage: coverageFraction(placed, reference.sequence.length, reference.isCircular),
    },
  };
}

function withinRead(position: number, start: number, end: number, isCircular: boolean, length: number): boolean {
  if (end >= start) return position >= start && position < end;
  return isCircular ? position >= start || position < end : false;
}

function coverageFraction(
  reads: { refStart: number | null; refEnd: number | null }[],
  length: number,
  isCircular: boolean,
): number {
  if (!length) return 0;
  const covered = new Uint8Array(length);
  for (const read of reads) {
    if (read.refStart === null || read.refEnd === null) continue;
    if (read.refEnd >= read.refStart) {
      for (let i = read.refStart; i < read.refEnd; i++) covered[i] = 1;
    } else if (isCircular) {
      for (let i = read.refStart; i < length; i++) covered[i] = 1;
      for (let i = 0; i < read.refEnd; i++) covered[i] = 1;
    }
  }
  return covered.reduce((a: number, b) => a + b, 0) / length;
}

export async function listAlignments(db: Db, opts: { referenceEntityId?: string; folderId?: string; limit?: number } = {}) {
  const rows = await db
    .select()
    .from(alignments)
    .where(
      and(
        opts.referenceEntityId ? eq(alignments.referenceEntityId, opts.referenceEntityId) : undefined,
        opts.folderId ? eq(alignments.folderId, opts.folderId) : undefined,
      ),
    )
    .orderBy(desc(alignments.createdAt))
    .limit(Math.min(opts.limit ?? 50, 200));

  if (!rows.length) return [];
  const counts = await db
    .select({ alignmentId: alignmentReads.alignmentId, id: alignmentReads.id, strand: alignmentReads.strand, variants: alignmentReads.variants })
    .from(alignmentReads)
    .where(inArray(alignmentReads.alignmentId, rows.map((r) => r.id)));

  return rows.map((row) => {
    const mine = counts.filter((c) => c.alignmentId === row.id);
    return {
      ...row,
      readCount: mine.length,
      placedCount: mine.filter((m) => m.strand !== 0).length,
      variantCount: mine.reduce((n, m) => n + m.variants.length, 0),
    };
  });
}

/** Re-run placement for an existing alignment, for instance after editing the reference. */
export async function recomputeAlignment(db: Db, actor: Actor, id: string, settings?: AlignmentSettings) {
  const { alignment, reads } = await getAlignment(db, id);
  const reference = await getSequenceEntity(db, alignment.referenceEntityId);
  const merged = {
    ...withDefaults(
      withDefaults(DEFAULT_SETTINGS, alignment.settings as Partial<typeof DEFAULT_SETTINGS>),
      settings as Partial<typeof DEFAULT_SETTINGS>,
    ),
    scoring: withDefaults(DNA_SCORING, settings?.scoring),
  };
  const referenceFeatures = toBioFeatures(reference.features);

  return db.transaction(async (tx) => {
    for (const read of reads) {
      const placed = placeRead(
        reference.sequence,
        reference.isCircular,
        referenceFeatures,
        { sequence: read.sequence, qualities: read.qualities ?? undefined },
        merged,
      );
      await tx.update(alignmentReads).set(placed).where(eq(alignmentReads.id, read.id));
    }
    await tx
      .update(alignments)
      .set({ settings: merged as unknown as Record<string, unknown>, modifiedAt: new Date() })
      .where(eq(alignments.id, id));
    await recordAudit(tx, actor, id, "update", { recomputed: { from: null, to: reads.length } });
    return getAlignment(tx, id);
  });
}

/** The chromatogram traces behind one read, for the trace viewer. */
export async function getReadChromatogram(db: Db, readId: string) {
  const [read] = await db.select().from(alignmentReads).where(eq(alignmentReads.id, readId));
  if (!read) throw new NotFoundError("Read", readId);
  if (!read.fileId) return null;
  const [file] = await db.select().from(files).where(eq(files.id, read.fileId));
  if (!file || file.detectedFormat !== "ab1") return null;
  const { bytes } = await readFileBytes(db, read.fileId);
  const { chromatogram } = parseAb1(bytes);
  if (!chromatogram) return null;
  return {
    readId,
    sequence: chromatogram.sequence,
    qualities: chromatogram.qualities,
    peakLocations: chromatogram.peakLocations,
    traces: chromatogram.traces,
    sampleName: chromatogram.sampleName,
  };
}
