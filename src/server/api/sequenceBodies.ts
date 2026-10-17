/** Request shapes for the sequence, file, alignment and cloning endpoints. */

import { z } from "zod";
import { CONSTRUCT_METHODS, ENTITY_TYPES, OLIGO_ROLES } from "../db/schema";

const id = z.string().min(3).max(64);
const range = z.object({ start: z.number().int().min(0), end: z.number().int().min(0) });
const dnaString = z.string().max(1_000_000);

export const featureBody = z.object({
  id: z.string().optional(),
  name: z.string().min(1).max(200),
  type: z.string().max(60).optional(),
  strand: z.number().int().optional(),
  segments: z.array(range).min(1).max(100).optional(),
  start: z.number().int().optional(),
  end: z.number().int().optional(),
  qualifiers: z.record(z.string(), z.array(z.string())).optional(),
  color: z.string().optional(),
  partial5: z.boolean().optional(),
  partial3: z.boolean().optional(),
});

// ---------------------------------------------------------------------------------------------
// Files and import

export const importCommitBody = z.object({
  fileId: id,
  folderId: id,
  indexes: z.array(z.number().int().min(0)).max(500).optional(),
  names: z.record(z.string(), z.string().max(200)).optional(),
  schemaId: id.nullish(),
  autoAnnotate: z.boolean().optional(),
  entityType: z.enum(ENTITY_TYPES).optional(),
  oligoRole: z.enum(OLIGO_ROLES).optional(),
});

export const importPasteBody = z.object({
  text: z.string().min(1).max(10_000_000),
  name: z.string().max(200).optional(),
  folderId: id,
  schemaId: id.nullish(),
  autoAnnotate: z.boolean().optional(),
});

// ---------------------------------------------------------------------------------------------
// Sequence tools

export const toolBody = z.discriminatedUnion("tool", [
  z.object({
    tool: z.literal("digest"),
    enzymes: z.array(z.string().max(40)).max(400).optional(),
    allEnzymes: z.boolean().optional(),
    maxCuts: z.number().int().min(1).max(100).optional(),
    agarose: z.number().min(0.3).max(4).optional(),
    ladder: z.string().max(80).optional(),
  }),
  z.object({
    tool: z.literal("design-primers"),
    target: range,
    targetTm: z.number().min(40).max(85).optional(),
    minLength: z.number().int().min(10).max(60).optional(),
    maxLength: z.number().int().min(10).max(80).optional(),
    forwardTail: z.string().max(100).optional(),
    reverseTail: z.string().max(100).optional(),
    limit: z.number().int().min(1).max(25).optional(),
  }),
  z.object({ tool: z.literal("pcr"), forward: dnaString, reverse: dnaString }),
  z.object({ tool: z.literal("primer-sites"), primer: dnaString }),
  z.object({
    tool: z.literal("guides"),
    enzyme: z.string().max(40).optional(),
    target: range.optional(),
    limit: z.number().int().min(1).max(200).optional(),
    offTargetEntityIds: z.array(id).max(10).optional(),
  }),
  z.object({
    tool: z.literal("orfs"),
    minAaLength: z.number().int().min(10).max(10000).optional(),
    requireStart: z.boolean().optional(),
    geneticCode: z.number().int().optional(),
  }),
  z.object({
    tool: z.literal("translate"),
    range,
    strand: z.union([z.literal(1), z.literal(-1)]).optional(),
    geneticCode: z.number().int().optional(),
  }),
  z.object({ tool: z.literal("properties"), range: range.optional() }),
  z.object({
    tool: z.literal("find"),
    pattern: z.string().min(3).max(5000),
    bothStrands: z.boolean().optional(),
    maxMismatches: z.number().int().min(0).max(5).optional(),
  }),
  z.object({ tool: z.literal("auto-annotate"), minOrfAa: z.number().int().min(0).max(5000).optional() }),
]);

export type ToolRequest = z.infer<typeof toolBody>;

// ---------------------------------------------------------------------------------------------
// Sequence editing

export const editSequenceBody = z.object({
  edits: z
    .array(z.object({ start: z.number().int().min(0), end: z.number().int().min(0), insert: dnaString }))
    .min(1)
    .max(100),
  reason: z.string().max(500).optional(),
});

export const addFeaturesBody = z.object({ features: z.array(featureBody).min(1).max(1000) });
export const setFeaturesBody = z.object({ features: z.array(featureBody).max(5000) });
export const originBody = z.object({ origin: z.number().int().min(0) });

// ---------------------------------------------------------------------------------------------
// Alignments

export const createAlignmentBody = z.object({
  name: z.string().min(1).max(200),
  referenceEntityId: id,
  folderId: id.nullish(),
  reads: z
    .array(
      z.object({
        name: z.string().min(1).max(200),
        fileId: id.optional(),
        sequence: dnaString.optional(),
        qualities: z.array(z.number().int().min(0).max(100)).optional(),
      }),
    )
    .min(1)
    .max(96),
  settings: z
    .object({
      trimQuality: z.number().int().min(0).max(60).optional(),
      minVariantQuality: z.number().int().min(0).max(60).optional(),
    })
    .optional(),
});

export const recomputeAlignmentBody = z.object({
  trimQuality: z.number().int().min(0).max(60).optional(),
  minVariantQuality: z.number().int().min(0).max(60).optional(),
});

// ---------------------------------------------------------------------------------------------
// Cloning

export const cloningBody = z.discriminatedUnion("method", [
  z.object({
    method: z.literal("restriction_ligation"),
    vectorEntityId: id,
    insertEntityId: id,
    enzymes: z.array(z.string().max(40)).min(1).max(6),
    vectorFragmentIndex: z.number().int().min(0).optional(),
    insertFragmentIndex: z.number().int().min(0).optional(),
  }),
  z.object({
    method: z.literal("golden_gate"),
    partEntityIds: z.array(id).min(2).max(12),
    enzyme: z.string().max(40),
    circular: z.boolean().optional(),
  }),
  z.object({
    method: z.literal("gibson"),
    fragmentEntityIds: z.array(id).min(2).max(10),
    minOverlap: z.number().int().min(10).max(80).optional(),
    circular: z.boolean().optional(),
  }),
  z.object({ method: z.literal("pcr"), templateEntityId: id, forward: dnaString, reverse: dnaString }),
]);

export type CloningRequest = z.infer<typeof cloningBody>;

export const saveConstructBody = z.object({
  name: z.string().min(1).max(200),
  folderId: id,
  schemaId: id.nullish(),
  sequence: dnaString,
  isCircular: z.boolean(),
  features: z
    .array(
      z.object({
        name: z.string().max(200),
        type: z.string().max(60),
        strand: z.number().int(),
        segments: z.array(range).min(1),
        qualifiers: z.record(z.string(), z.array(z.string())).optional(),
        color: z.string().optional(),
      }),
    )
    .max(5000)
    .optional(),
  method: z.enum(CONSTRUCT_METHODS),
  parents: z.array(z.object({ entityId: id, role: z.string().max(80).optional() })).max(20),
  details: z.record(z.string(), z.unknown()).optional(),
});
