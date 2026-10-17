/**
 * Cloning workflows: simulate a construction, show the scientist the product, and — only when
 * they accept it — create the resulting entity with its lineage recorded.
 *
 * Simulation and creation are separate so nothing is written until the product has been checked.
 */

import {
  assembleByEnds,
  gibsonAssembly,
  goldenGate,
  restrictionClone,
  type AssemblyProduct,
  type AssemblyResult,
  type SourceMolecule,
} from "@/bio/assembly";
import { digest, getEnzyme } from "@/bio/enzymes";
import { simulatePcr } from "@/bio/primers";
import type { Db } from "../db/client";
import type { ConstructMethod } from "../db/schema";
import type { Actor } from "./audit";
import { createEntity, getEntity } from "./entities";
import { ValidationError } from "./errors";
import { recordLineage } from "./lineage";
import { fromBioFeatures, toBioFeatures } from "./sequenceSupport";
import { getSequenceEntity } from "./sequenceTools";

async function toSource(db: Db, entityId: string): Promise<SourceMolecule> {
  const entity = await getSequenceEntity(db, entityId);
  return {
    id: entity.id,
    name: entity.name,
    sequence: entity.sequence,
    isCircular: entity.isCircular,
    features: toBioFeatures(entity.features),
  };
}

export interface SimulatedAssembly {
  method: ConstructMethod;
  products: (AssemblyProduct & { length: number })[];
  errors: string[];
  warnings: string[];
  /** entity ids that went into the simulation, in the order supplied */
  sourceEntityIds: string[];
}

function shape(method: ConstructMethod, result: AssemblyResult, sourceEntityIds: string[]): SimulatedAssembly {
  return {
    method,
    products: result.products.map((p) => ({ ...p, length: p.sequence.length })),
    errors: result.errors,
    warnings: result.warnings,
    sourceEntityIds,
  };
}

// ---------------------------------------------------------------------------------------------
// Simulation

export interface RestrictionCloneRequest {
  vectorEntityId: string;
  insertEntityId: string;
  enzymes: string[];
  vectorFragmentIndex?: number;
  insertFragmentIndex?: number;
}

export async function simulateRestrictionClone(db: Db, request: RestrictionCloneRequest): Promise<SimulatedAssembly & { vectorFragments: unknown[]; insertFragments: unknown[] }> {
  if (!request.enzymes?.length) throw new ValidationError("Choose at least one enzyme");
  const unknown = request.enzymes.filter((e) => !getEnzyme(e));
  if (unknown.length) throw new ValidationError(`Unknown enzyme(s): ${unknown.join(", ")}`);

  const [vector, insert] = await Promise.all([toSource(db, request.vectorEntityId), toSource(db, request.insertEntityId)]);
  const result = restrictionClone({
    vector,
    insert,
    enzymes: request.enzymes,
    vectorFragmentIndex: request.vectorFragmentIndex,
    insertFragmentIndex: request.insertFragmentIndex,
  });

  // Show every fragment so the scientist can pick a different one if the default is wrong.
  const vectorDigest = digest(vector.sequence, vector.isCircular, request.enzymes);
  const insertDigest = digest(insert.sequence, insert.isCircular, request.enzymes);
  const describe = (fragments: typeof vectorDigest.fragments) =>
    fragments.map((f, index) => ({
      index,
      length: f.length,
      leftEnd: f.leftEnd,
      rightEnd: f.rightEnd,
      range: f.range,
    }));

  return {
    ...shape("restriction_ligation", result, [request.vectorEntityId, request.insertEntityId]),
    vectorFragments: describe(vectorDigest.fragments),
    insertFragments: describe(insertDigest.fragments),
  };
}

export interface GoldenGateRequest {
  partEntityIds: string[];
  enzyme: string;
  circular?: boolean;
}

export async function simulateGoldenGate(db: Db, request: GoldenGateRequest): Promise<SimulatedAssembly> {
  if (request.partEntityIds.length < 2) throw new ValidationError("Golden Gate needs at least two parts");
  const enzyme = getEnzyme(request.enzyme);
  if (!enzyme) throw new ValidationError(`Unknown enzyme ${request.enzyme}`);
  const parts = [];
  for (const id of request.partEntityIds) parts.push(await toSource(db, id));
  return shape("golden_gate", goldenGate({ parts, enzyme, circular: request.circular ?? true }), request.partEntityIds);
}

export interface GibsonRequest {
  fragmentEntityIds: string[];
  minOverlap?: number;
  circular?: boolean;
}

export async function simulateGibson(db: Db, request: GibsonRequest): Promise<SimulatedAssembly> {
  if (request.fragmentEntityIds.length < 2) throw new ValidationError("Gibson assembly needs at least two fragments");
  const fragments = [];
  for (const id of request.fragmentEntityIds) fragments.push(await toSource(db, id));
  return shape(
    "gibson",
    gibsonAssembly({ fragments, minOverlap: request.minOverlap ?? 15, circular: request.circular ?? true }),
    request.fragmentEntityIds,
  );
}

export interface PcrProductRequest {
  templateEntityId: string;
  forward: string;
  reverse: string;
  /** when the primers are stored oligos, record them as parents too */
  forwardOligoId?: string;
  reverseOligoId?: string;
}

export async function simulatePcrProduct(db: Db, request: PcrProductRequest) {
  const template = await getSequenceEntity(db, request.templateEntityId);
  const result = simulatePcr(
    template.sequence,
    request.forward.replace(/\s/g, "").toUpperCase(),
    request.reverse.replace(/\s/g, "").toUpperCase(),
    template.isCircular,
  );
  return {
    method: "pcr" as const,
    products: result.products,
    warnings: result.warnings,
    errors: result.products.length ? [] : ["No product: see the warnings for which primer failed to anneal."],
    sourceEntityIds: [request.templateEntityId],
  };
}

// ---------------------------------------------------------------------------------------------
// Creating the product

export interface CreateProductInput {
  name: string;
  folderId: string;
  schemaId?: string | null;
  sequence: string;
  isCircular: boolean;
  features?: { name: string; type: string; strand: number; segments: { start: number; end: number }[]; qualifiers?: Record<string, string[]>; color?: string }[];
  method: ConstructMethod;
  /** parents, with the role each played */
  parents: { entityId: string; role?: string }[];
  /** enzymes, overlaps, primers — whatever makes the step reproducible */
  details?: Record<string, unknown>;
}

/**
 * Create the entity a simulation produced, recording where it came from.
 *
 * The sequence is taken from the simulation result rather than recomputed, so what the scientist
 * approved is exactly what is saved.
 */
export async function createConstruct(db: Db, actor: Actor, input: CreateProductInput) {
  if (!input.sequence?.length) throw new ValidationError("The product has no sequence");
  for (const parent of input.parents) await getEntity(db, parent.entityId);

  return db.transaction(async (tx) => {
    const entity = await createEntity(tx, actor, {
      name: input.name,
      folderId: input.folderId,
      schemaId: input.schemaId ?? null,
      entityType: "dna_sequence",
      sequence: input.sequence,
      isCircular: input.isCircular,
      features: input.features?.map((f) => ({
        name: f.name,
        type: f.type,
        strand: f.strand,
        segments: f.segments,
        qualifiers: f.qualifiers,
        color: f.color,
      })),
    });

    await recordLineage(
      tx,
      actor,
      input.parents.length
        ? input.parents.map((parent) => ({
            childEntityId: entity.id,
            parentEntityId: parent.entityId,
            method: input.method,
            role: parent.role,
            details: input.details ?? {},
          }))
        : [{ childEntityId: entity.id, method: input.method, details: input.details ?? {} }],
    );
    return entity;
  });
}

/** Convenience: take a simulated product straight to a saved entity. */
export async function saveSimulatedProduct(
  db: Db,
  actor: Actor,
  input: {
    simulation: SimulatedAssembly;
    productIndex: number;
    name: string;
    folderId: string;
    schemaId?: string | null;
    details?: Record<string, unknown>;
  },
) {
  const product = input.simulation.products[input.productIndex];
  if (!product) throw new ValidationError(`No product at index ${input.productIndex}`);

  return createConstruct(db, actor, {
    name: input.name,
    folderId: input.folderId,
    schemaId: input.schemaId,
    sequence: product.sequence,
    isCircular: product.isCircular,
    features: product.features.map((f) => ({
      name: f.name,
      type: f.type,
      strand: f.strand,
      segments: f.segments,
      qualifiers: f.qualifiers,
      color: f.color,
    })),
    method: input.simulation.method,
    parents: product.order.map((o) => ({ entityId: baseEntityId(o.partId), role: o.name })),
    details: {
      ...input.details,
      junctions: product.junctions.map((j) => ({ kind: j.kind, sequence: j.sequence, position: j.position })),
      order: product.order.map((o) => ({ partId: o.partId, flipped: o.flipped })),
    },
  });
}

/** Fragment part ids look like `ent_abc:2`; the entity id is the part before the colon. */
function baseEntityId(partId: string): string {
  return partId.split(":")[0]!;
}

export { fromBioFeatures };
