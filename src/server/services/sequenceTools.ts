/**
 * Server side of the sequence tools: digests, primer design, PCR, CRISPR guides, ORFs and
 * translation, run against a stored entity.
 *
 * These are pure computations over an entity's sequence, so each one loads the entity, delegates
 * to the bio engine and shapes the result for the UI.
 */

import { alignPair, alignRead } from "@/bio/align";
import { findGuides, getCasEnzyme, guideCloningOligos, type Guide } from "@/bio/crispr";
import { applyEdits, reverseComplementSequence, setOrigin, type SequenceEdit } from "@/bio/edit";
import {
  COMMON_ENZYMES,
  digest,
  ENZYMES,
  findCutSites,
  getEnzyme,
  summarizeDigest,
  type Enzyme,
} from "@/bio/enzymes";
import { suggestAnnotations } from "@/bio/features/annotate";
import { buildLane, getLadder, suggestAgarose, type GelLane } from "@/bio/gel";
import { designPrimers, findBindingSites, primerStats, simulatePcr, type PrimerPair } from "@/bio/primers";
import type { Range } from "@/bio/range";
import { findMatches, findOrfs, gcContent, reverseComplement, translate, GENETIC_CODES } from "@/bio/seq";
import { meltingTemp, PCR_CONDITIONS } from "@/bio/thermo";
import type { Db } from "../db/client";
import { eq } from "drizzle-orm";
import { entities } from "../db/schema";
import { diff, recordAudit, type Actor } from "./audit";
import { getEntity } from "./entities";
import { ValidationError } from "./errors";
import { canBeCircular, checkFeatures, fromBioFeatures, toBioFeatures, toStoredFeatures } from "./sequenceSupport";

/** Load an entity and insist it carries a sequence. */
export async function getSequenceEntity(db: Db, id: string) {
  const entity = await getEntity(db, id);
  if (!entity.sequence) throw new ValidationError("This entity has no sequence");
  return { ...entity, sequence: entity.sequence };
}

// ---------------------------------------------------------------------------------------------
// Restriction analysis

export interface DigestRequest {
  /** enzyme names; defaults to the common set */
  enzymes?: string[];
  /** only report enzymes cutting at most this many times */
  maxCuts?: number;
  /** include every enzyme in the catalogue rather than the common ones */
  allEnzymes?: boolean;
  /** agarose percentage for the simulated gel; auto-chosen when omitted */
  agarose?: number;
  ladder?: string;
}

export async function runDigest(db: Db, entityId: string, request: DigestRequest = {}) {
  const entity = await getSequenceEntity(db, entityId);
  const selected: readonly (Enzyme | string)[] = request.enzymes?.length
    ? request.enzymes
    : request.allEnzymes
      ? ENZYMES
      : COMMON_ENZYMES;

  const unknown = request.enzymes?.filter((name) => !getEnzyme(name)) ?? [];
  if (unknown.length) throw new ValidationError(`Unknown enzyme(s): ${unknown.join(", ")}`);

  const { sites, fragments } = digest(entity.sequence, entity.isCircular, selected);
  const summary = summarizeDigest(sites).filter((s) => (request.maxCuts ? s.cuts <= request.maxCuts : true));
  const sizes = fragments.map((f) => f.length);
  const agarose = request.agarose ?? suggestAgarose(sizes);
  const ladder = getLadder(request.ladder ?? "1 kb Plus DNA ladder");

  const lanes: GelLane[] = [
    ...(ladder ? [buildLane(ladder.name, ladder.sizes, { agarose })] : []),
    buildLane(entity.name, sizes, { agarose }),
  ];

  return {
    entity: { id: entity.id, name: entity.name, length: entity.sequence.length, isCircular: entity.isCircular },
    sites: sites.map((s) => ({
      enzyme: s.enzyme.name,
      topCut: s.topCut,
      bottomCut: s.bottomCut,
      siteRange: s.siteRange,
      strand: s.strand,
      overhang: s.overhang,
      overhangType: s.overhangType,
      isTypeIIS: s.enzyme.isTypeIIS,
    })),
    summary: summary.map((s) => ({
      enzyme: s.enzyme.name,
      site: s.enzyme.site,
      cuts: s.cuts,
      positions: s.positions,
      overhangType: s.enzyme.overhangType,
      isTypeIIS: s.enzyme.isTypeIIS,
    })),
    fragments: fragments.map((f, index) => ({
      index,
      length: f.length,
      range: f.range,
      leftEnd: f.leftEnd,
      rightEnd: f.rightEnd,
      /** long fragments are summarised rather than returned in full */
      sequence: f.sequence.length <= 5000 ? f.sequence : null,
    })),
    gel: { agarose, lanes },
    /** enzymes that do not cut at all, which is what you want for a cloning site */
    nonCutters: (request.allEnzymes ? ENZYMES : COMMON_ENZYMES)
      .filter((e) => !sites.some((s) => s.enzyme.name === e.name))
      .map((e) => e.name),
  };
}

// ---------------------------------------------------------------------------------------------
// Primers and PCR

export interface DesignPrimersRequest {
  target: Range;
  targetTm?: number;
  minLength?: number;
  maxLength?: number;
  forwardTail?: string;
  reverseTail?: string;
  limit?: number;
}

export async function runPrimerDesign(db: Db, entityId: string, request: DesignPrimersRequest): Promise<{ pairs: PrimerPair[]; warnings: string[] }> {
  const entity = await getSequenceEntity(db, entityId);
  const { start, end } = request.target;
  if (!Number.isInteger(start) || !Number.isInteger(end)) throw new ValidationError("Target start and end must be integers");
  if (start < 0 || start >= entity.sequence.length) throw new ValidationError("Target start is outside the sequence");
  if (end < 1 || end > entity.sequence.length) throw new ValidationError("Target end is outside the sequence");
  if (end <= start && !entity.isCircular) throw new ValidationError("Target end must be after its start");

  const pairs = designPrimers(entity.sequence, request.target, entity.isCircular, {
    targetTm: request.targetTm,
    minLength: request.minLength,
    maxLength: request.maxLength,
    forwardTail: request.forwardTail,
    reverseTail: request.reverseTail,
    limit: request.limit,
  });
  const warnings: string[] = [];
  if (!pairs.length) warnings.push("No primer pair met the criteria. Try widening the Tm tolerance or the length range.");
  return { pairs, warnings };
}

export async function runPcr(db: Db, entityId: string, forward: string, reverse: string) {
  const entity = await getSequenceEntity(db, entityId);
  const clean = (s: string) => s.replace(/\s/g, "").toUpperCase();
  if (clean(forward).length < 10 || clean(reverse).length < 10) {
    throw new ValidationError("Both primers must be at least 10 bases");
  }
  const result = simulatePcr(entity.sequence, clean(forward), clean(reverse), entity.isCircular);
  return {
    ...result,
    forwardStats: primerStats(clean(forward)),
    reverseStats: primerStats(clean(reverse)),
    products: result.products.map((p) => ({
      ...p,
      // Long amplicons are summarised; the UI fetches the full sequence only on request.
      sequence: p.sequence.length <= 50000 ? p.sequence : p.sequence.slice(0, 1000),
      truncated: p.sequence.length > 50000,
    })),
  };
}

/** Where a given oligo anneals on a sequence, for the "check my primer" panel. */
export async function findPrimerSites(db: Db, entityId: string, primer: string) {
  const entity = await getSequenceEntity(db, entityId);
  const clean = primer.replace(/\s/g, "").toUpperCase();
  if (clean.length < 8) throw new ValidationError("Primer is too short to search for");
  return {
    stats: primerStats(clean),
    sites: findBindingSites(entity.sequence, clean, entity.isCircular, { conditions: PCR_CONDITIONS }),
  };
}

// ---------------------------------------------------------------------------------------------
// CRISPR

export interface GuideRequest {
  enzyme?: string;
  target?: Range;
  limit?: number;
  /** other entity ids to search for off-targets */
  offTargetEntityIds?: string[];
}

export async function runGuideSearch(db: Db, entityId: string, request: GuideRequest = {}) {
  const entity = await getSequenceEntity(db, entityId);
  const casEnzyme = request.enzyme ? getCasEnzyme(request.enzyme) : undefined;
  if (request.enzyme && !casEnzyme) throw new ValidationError(`Unknown Cas enzyme: ${request.enzyme}`);

  const sources = [];
  for (const id of request.offTargetEntityIds ?? []) {
    const other = await getSequenceEntity(db, id);
    sources.push({ name: other.name, sequence: other.sequence, isCircular: other.isCircular });
  }

  const guides = findGuides(entity.sequence, entity.isCircular, {
    enzyme: casEnzyme,
    targetRange: request.target,
    offTargetSources: sources,
    limit: request.limit ?? 50,
  });

  return {
    enzyme: (casEnzyme ?? getCasEnzyme("SpCas9")!).name,
    guides: guides.map((g: Guide) => ({
      ...g,
      cloningOligos: guideCloningOligos(g.spacer),
      offTargets: g.offTargets.slice(0, 20),
      offTargetCount: g.offTargets.length,
    })),
  };
}

// ---------------------------------------------------------------------------------------------
// Reading frames, translation and composition

export async function runOrfSearch(db: Db, entityId: string, opts: { minAaLength?: number; requireStart?: boolean; geneticCode?: number } = {}) {
  const entity = await getSequenceEntity(db, entityId);
  if (entity.entityType === "aa_sequence") throw new ValidationError("Open reading frames apply to nucleotide sequences");
  const code = GENETIC_CODES[opts.geneticCode ?? 1];
  if (!code) throw new ValidationError(`Unknown genetic code table ${opts.geneticCode}`);
  const orfs = findOrfs(entity.sequence, entity.isCircular, {
    minAaLength: opts.minAaLength ?? 50,
    requireStart: opts.requireStart ?? true,
    code,
  });
  return {
    orfs: orfs.map((o) => ({ ...o, protein: o.protein.length > 2000 ? `${o.protein.slice(0, 2000)}…` : o.protein })),
    geneticCode: { id: code.id, name: code.name },
  };
}

export async function runTranslation(db: Db, entityId: string, range: Range, strand: 1 | -1, geneticCode = 1) {
  const entity = await getSequenceEntity(db, entityId);
  const code = GENETIC_CODES[geneticCode];
  if (!code) throw new ValidationError(`Unknown genetic code table ${geneticCode}`);
  const bases = sliceEntity(entity.sequence, range, entity.isCircular);
  const oriented = strand === -1 ? reverseComplement(bases) : bases;
  return {
    bases: oriented,
    protein: translate(oriented, { code, initiatorMet: true }),
    proteinToStop: translate(oriented, { code, toStop: true, initiatorMet: true }),
    length: oriented.length,
    gc: gcContent(oriented),
    tm: oriented.length <= 200 ? meltingTemp(oriented) : null,
  };
}

/** Composition and physical properties for the sequence as a whole or a selection. */
export async function runProperties(db: Db, entityId: string, range?: Range) {
  const entity = await getSequenceEntity(db, entityId);
  const bases = range ? sliceEntity(entity.sequence, range, entity.isCircular) : entity.sequence;
  const counts: Record<string, number> = {};
  for (const ch of bases.toUpperCase()) counts[ch] = (counts[ch] ?? 0) + 1;
  const isProtein = entity.entityType === "aa_sequence";

  return {
    length: bases.length,
    counts,
    gc: isProtein ? null : gcContent(bases),
    tm: !isProtein && bases.length >= 8 && bases.length <= 200 ? meltingTemp(bases) : null,
    molecularWeight: molecularWeight(bases, isProtein),
    isCircular: entity.isCircular,
  };
}

/** Average molecular weight in daltons: ssDNA/RNA per nucleotide, or a protein's residues. */
function molecularWeight(sequence: string, isProtein: boolean): number {
  const DNA: Record<string, number> = { A: 313.21, C: 289.18, G: 329.21, T: 304.2, U: 306.17 };
  const AA: Record<string, number> = {
    A: 71.08, R: 156.19, N: 114.1, D: 115.09, C: 103.14, E: 129.12, Q: 128.13, G: 57.05, H: 137.14,
    I: 113.16, L: 113.16, K: 128.17, M: 131.19, F: 147.18, P: 97.12, S: 87.08, T: 101.1, W: 186.21,
    Y: 163.18, V: 99.13,
  };
  const table = isProtein ? AA : DNA;
  let total = 0;
  for (const ch of sequence.toUpperCase()) total += table[ch] ?? 0;
  // Proteins gain a water molecule; linear nucleic acids lose a phosphate at the 5' end.
  return Math.round((isProtein ? total + 18.02 : total - 61.96) * 100) / 100;
}

export async function runMotifSearch(db: Db, entityId: string, pattern: string, opts: { bothStrands?: boolean; maxMismatches?: number } = {}) {
  const entity = await getSequenceEntity(db, entityId);
  const clean = pattern.replace(/\s/g, "").toUpperCase();
  if (clean.length < 3) throw new ValidationError("Search for at least three bases");
  if (clean.length > entity.sequence.length) throw new ValidationError("The pattern is longer than the sequence");
  const matches = findMatches(entity.sequence, clean, entity.isCircular, {
    bothStrands: opts.bothStrands ?? true,
    maxMismatches: opts.maxMismatches ?? 0,
    degeneracy: "pattern",
  });
  return { pattern: clean, matches: matches.slice(0, 1000), total: matches.length };
}

// ---------------------------------------------------------------------------------------------
// Editing

export interface EditSequenceRequest {
  edits: SequenceEdit[];
  /** recorded in the audit trail so the history explains the change */
  reason?: string;
}

/**
 * Apply edits to a stored sequence, moving its features with the change.
 *
 * Registered entities are immutable, which is enforced here as well as in the entity service.
 */
export async function editSequence(db: Db, actor: Actor, entityId: string, request: EditSequenceRequest) {
  if (!request.edits.length) throw new ValidationError("No edits given");
  return db.transaction(async (tx) => {
    const before = await getSequenceEntity(tx, entityId);
    if (before.registryId) throw new ValidationError("Registered sequences are immutable; create a new version instead");
    if (before.archivedAt) throw new ValidationError("Archived sequences cannot be edited");

    for (const edit of request.edits) {
      if (!Number.isInteger(edit.start) || !Number.isInteger(edit.end) || edit.start < 0 || edit.end < edit.start) {
        throw new ValidationError("Each edit needs a valid start and end");
      }
      if (edit.end > before.sequence.length) throw new ValidationError("Edit extends past the end of the sequence");
    }

    const result = applyEdits(before.sequence, toBioFeatures(before.features), request.edits, before.isCircular);
    const features = toStoredFeatures(result.features);

    const [after] = await tx
      .update(entities)
      .set({ sequence: result.sequence, features, modifiedAt: new Date() })
      .where(eq(entities.id, entityId))
      .returning();

    await recordAudit(tx, actor, entityId, "update", {
      sequence: { from: `${before.sequence.length} bp`, to: `${result.sequence.length} bp` },
      ...(request.reason ? { reason: { from: null, to: request.reason } } : {}),
      ...(result.removed.length ? { featuresRemoved: { from: null, to: result.removed.map((f) => f.name) } } : {}),
    });
    return { entity: after!, removedFeatures: result.removed.map((f) => f.name), truncatedFeatures: result.truncated.map((f) => f.name) };
  });
}

/** Rotate a plasmid so a chosen base becomes position 1. */
export async function changeOrigin(db: Db, actor: Actor, entityId: string, newOrigin: number) {
  return db.transaction(async (tx) => {
    const before = await getSequenceEntity(tx, entityId);
    if (!before.isCircular) throw new ValidationError("Only circular sequences have an origin to move");
    if (before.registryId) throw new ValidationError("Registered sequences are immutable");
    if (!Number.isInteger(newOrigin) || newOrigin < 0 || newOrigin >= before.sequence.length) {
      throw new ValidationError("The new origin must be a position within the sequence");
    }
    const rotated = setOrigin(before.sequence, toBioFeatures(before.features), newOrigin);
    const features = toStoredFeatures(rotated.features);
    const [after] = await tx
      .update(entities)
      .set({ sequence: rotated.sequence, features, modifiedAt: new Date() })
      .where(eq(entities.id, entityId))
      .returning();
    await recordAudit(tx, actor, entityId, "update", { origin: { from: 1, to: newOrigin + 1 } });
    return after!;
  });
}

/** Flip a molecule onto the other strand. */
export async function flipSequence(db: Db, actor: Actor, entityId: string) {
  return db.transaction(async (tx) => {
    const before = await getSequenceEntity(tx, entityId);
    if (before.registryId) throw new ValidationError("Registered sequences are immutable");
    const flipped = reverseComplementSequence(before.sequence, toBioFeatures(before.features));
    const features = toStoredFeatures(flipped.features);
    const [after] = await tx
      .update(entities)
      .set({ sequence: flipped.sequence, features, modifiedAt: new Date() })
      .where(eq(entities.id, entityId))
      .returning();
    await recordAudit(tx, actor, entityId, "update", { strand: { from: "as entered", to: "reverse complement" } });
    return after!;
  });
}

// ---------------------------------------------------------------------------------------------
// Annotation

export async function runAutoAnnotate(db: Db, entityId: string, opts: { minOrfAa?: number } = {}) {
  const entity = await getSequenceEntity(db, entityId);
  const suggestions = suggestAnnotations(entity.sequence, entity.isCircular, {
    minOrfAa: opts.minOrfAa ?? 0,
    existing: entity.features,
  });
  return { suggestions: suggestions.map((s) => ({ ...s, qualifiers: s.qualifiers ?? {} })) };
}

/** Add features to an entity, keeping the existing ones. */
export async function addFeatures(db: Db, actor: Actor, entityId: string, incoming: Parameters<typeof checkFeatures>[1]) {
  return db.transaction(async (tx) => {
    const entity = await getSequenceEntity(tx, entityId);
    if (entity.archivedAt) throw new ValidationError("Archived sequences cannot be edited");
    const added = checkFeatures(entity.entityType, incoming, entity.sequence, entity.isCircular);
    const features = [...entity.features, ...added];
    const [after] = await tx
      .update(entities)
      .set({ features, modifiedAt: new Date() })
      .where(eq(entities.id, entityId))
      .returning();
    await recordAudit(tx, actor, entityId, "update", {
      featuresAdded: { from: null, to: added.map((f) => f.name) },
    });
    return after!;
  });
}

function sliceEntity(sequence: string, range: Range, isCircular: boolean): string {
  const { start, end } = range;
  if (end > start) return sequence.slice(start, end);
  if (!isCircular) throw new ValidationError("Range end must be after its start on a linear sequence");
  return sequence.slice(start) + sequence.slice(0, end);
}

/** Align two stored sequences directly, for comparing two constructs. */
export async function comparePair(db: Db, aId: string, bId: string) {
  const [a, b] = await Promise.all([getSequenceEntity(db, aId), getSequenceEntity(db, bId)]);
  const alignment =
    a.sequence.length * b.sequence.length > 25_000_000
      ? alignRead(a.sequence, b.sequence, a.isCircular)
      : alignPair(a.sequence, b.sequence, "global");
  if (!alignment) throw new ValidationError("These sequences are too dissimilar to align");
  return {
    a: { id: a.id, name: a.name, length: a.sequence.length },
    b: { id: b.id, name: b.name, length: b.sequence.length },
    identity: alignment.identity,
    matches: alignment.matches,
    mismatches: alignment.mismatches,
    gaps: alignment.gaps,
    cigar: alignment.cigar,
    alignedRef: alignment.alignedRef.slice(0, 20000),
    alignedQuery: alignment.alignedQuery.slice(0, 20000),
    truncated: alignment.alignedRef.length > 20000,
  };
}

export { canBeCircular, fromBioFeatures };
