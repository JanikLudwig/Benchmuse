/**
 * Plasmid construction: sticky-end ligation (restriction cloning and Golden Gate) and
 * homology-based assembly (Gibson, In-Fusion, SLIC, overlap-extension PCR).
 *
 * Fragments are represented by their top strand between cut positions, so concatenating the
 * chosen order reconstructs the product exactly; the end descriptions are only used to decide
 * which orders are chemically possible. Features ride along and are remapped into the product.
 */

import { digest, endsCompatible, getEnzyme, type DigestEnd, type Enzyme, type Fragment } from "./enzymes";
import type { BioFeature } from "./formats/types";
import type { Range } from "./range";
import { overlapLength, reverseComplement } from "./seq";

export interface AssemblyPart {
  id: string;
  name: string;
  /** top strand of the double-stranded fragment */
  sequence: string;
  leftEnd: DigestEnd;
  rightEnd: DigestEnd;
  features?: BioFeature[];
  /** when false the part may not be reverse-complemented (e.g. a directional backbone) */
  allowFlip?: boolean;
  /** set by `flipPart`; reported in the assembly order */
  flipped?: boolean;
}

export interface Junction {
  leftPartId: string;
  rightPartId: string;
  /** overhang or homology sequence joining them */
  sequence: string;
  kind: "sticky" | "blunt" | "homology";
  /** position of the junction in the product */
  position: number;
}

export interface AssemblyProduct {
  sequence: string;
  isCircular: boolean;
  features: BioFeature[];
  order: { partId: string; name: string; flipped: boolean; start: number; end: number }[];
  junctions: Junction[];
}

export interface AssemblyResult {
  products: AssemblyProduct[];
  errors: string[];
  warnings: string[];
}

const BLUNT: DigestEnd = { type: "blunt", overhang: "", enzyme: null };

/** Reverse-complement a part, swapping and flipping its ends. */
export function flipPart(part: AssemblyPart): AssemblyPart {
  return {
    ...part,
    flipped: !part.flipped,
    sequence: reverseComplement(part.sequence),
    leftEnd: flipEnd(part.rightEnd),
    rightEnd: flipEnd(part.leftEnd),
    features: part.features?.map((f) => flipFeature(f, part.sequence.length)),
  };
}

function flipEnd(end: DigestEnd): DigestEnd {
  return { ...end, overhang: reverseComplement(end.overhang) };
}

function flipFeature(feature: BioFeature, length: number): BioFeature {
  return {
    ...feature,
    strand: feature.strand === 0 ? 0 : ((feature.strand * -1) as 1 | -1),
    segments: [...feature.segments].reverse().map((s) => ({ start: length - s.end, end: length - s.start })),
  };
}

/**
 * Assemble parts by their ends.
 *
 * Tries every order and orientation (parts may be pinned with `allowFlip: false`) and returns
 * each distinct product. For circular assembly the last part must also join back to the first.
 */
export function assembleByEnds(
  parts: readonly AssemblyPart[],
  opts: { circular?: boolean; maxProducts?: number } = {},
): AssemblyResult {
  const circular = opts.circular ?? true;
  const maxProducts = opts.maxProducts ?? 10;
  const errors: string[] = [];
  const warnings: string[] = [];

  if (parts.length === 0) return { products: [], errors: ["No fragments to assemble"], warnings };
  if (parts.length > 12) return { products: [], errors: ["Too many fragments to enumerate (limit is 12)"], warnings };

  const bluntCount = parts.filter((p) => p.leftEnd.type === "blunt" || p.rightEnd.type === "blunt").length;
  if (bluntCount > 0) {
    warnings.push("Blunt ends join in either orientation, so some products below differ only in how a fragment is inserted.");
  }

  const products: AssemblyProduct[] = [];
  const seen = new Set<string>();
  const n = parts.length;

  const search = (chain: AssemblyPart[], used: boolean[]) => {
    if (products.length >= maxProducts) return;
    if (chain.length === n) {
      if (circular && !endsCompatible(chain[chain.length - 1]!.rightEnd, chain[0]!.leftEnd)) return;
      const product = buildProduct(chain, circular);
      // Rotations and reverse complements of the same circle are the same molecule.
      const key = canonicalKey(product.sequence, circular);
      if (!seen.has(key)) {
        seen.add(key);
        products.push(product);
      }
      return;
    }
    for (let i = 0; i < n; i++) {
      if (used[i]) continue;
      const orientations = parts[i]!.allowFlip === false ? [parts[i]!] : [parts[i]!, flipPart(parts[i]!)];
      for (const oriented of orientations) {
        if (chain.length && !endsCompatible(chain[chain.length - 1]!.rightEnd, oriented.leftEnd)) continue;
        used[i] = true;
        search([...chain, oriented], used);
        used[i] = false;
      }
    }
  };

  // Pin the first part's identity to avoid reporting every rotation of the same circle.
  const first = parts[0]!;
  const firstOrientations = first.allowFlip === false ? [first] : [first, flipPart(first)];
  for (const oriented of firstOrientations) {
    const used = new Array(n).fill(false);
    used[0] = true;
    search([oriented], used);
  }

  if (!products.length) {
    errors.push(
      circular
        ? "These fragments cannot be joined into a circle: no arrangement has compatible ends all the way round."
        : "These fragments cannot be joined: no arrangement has compatible ends.",
    );
    errors.push(...describeIncompatibility(parts));
  }
  return { products, errors, warnings };
}

function describeIncompatibility(parts: readonly AssemblyPart[]): string[] {
  const notes: string[] = [];
  const overhangs = new Map<string, number>();
  for (const part of parts) {
    for (const end of [part.leftEnd, part.rightEnd]) {
      const key = `${end.type}:${end.overhang.toUpperCase()}`;
      overhangs.set(key, (overhangs.get(key) ?? 0) + 1);
    }
  }
  const unpaired = [...overhangs.entries()].filter(([key, count]) => count === 1 && !key.startsWith("blunt"));
  for (const [key] of unpaired.slice(0, 4)) {
    const [, overhang] = key.split(":");
    notes.push(`Overhang ${overhang} appears on only one fragment end, so it has nothing to ligate to.`);
  }
  return notes;
}

function buildProduct(chain: readonly AssemblyPart[], circular: boolean): AssemblyProduct {
  let sequence = "";
  const order: AssemblyProduct["order"] = [];
  const features: BioFeature[] = [];
  const junctions: Junction[] = [];

  for (const [index, part] of chain.entries()) {
    const start = sequence.length;
    sequence += part.sequence;
    order.push({ partId: part.id, name: part.name, flipped: part.flipped ?? false, start, end: sequence.length });
    for (const feature of part.features ?? []) {
      features.push(shiftFeature(feature, start));
    }
    const next = chain[(index + 1) % chain.length];
    if (next && (index < chain.length - 1 || circular)) {
      junctions.push({
        leftPartId: part.id,
        rightPartId: next.id,
        sequence: part.rightEnd.overhang,
        kind: part.rightEnd.type === "blunt" ? "blunt" : "sticky",
        position: sequence.length,
      });
    }
  }
  return { sequence, isCircular: circular, features, order, junctions };
}

function shiftFeature(feature: BioFeature, offset: number): BioFeature {
  return { ...feature, segments: feature.segments.map((s) => ({ start: s.start + offset, end: s.end + offset })) };
}

/** Rotation- and strand-independent key, so the same plasmid is not reported twice. */
function canonicalKey(sequence: string, circular: boolean): string {
  const upper = sequence.toUpperCase();
  if (!circular) {
    const rc = reverseComplement(upper);
    return upper < rc ? upper : rc;
  }
  const candidates: string[] = [];
  for (const strand of [upper, reverseComplement(upper)]) {
    const doubled = strand + strand;
    for (let i = 0; i < strand.length; i++) candidates.push(doubled.slice(i, i + strand.length));
  }
  return candidates.reduce((best, c) => (c < best ? c : best), candidates[0] ?? "");
}

// ---------------------------------------------------------------------------------------------
// Homology-based assembly (Gibson and friends)

export interface GibsonOptions {
  minOverlap?: number;
  maxOverlap?: number;
  circular?: boolean;
  maxProducts?: number;
}

/**
 * Join fragments that share terminal homology, as Gibson assembly and In-Fusion do.
 *
 * The shared sequence appears once in the product, which is what makes overlap design errors
 * (too short, or accidentally shared between several fragments) show up as warnings here.
 */
export function assembleByHomology(parts: readonly AssemblyPart[], opts: GibsonOptions = {}): AssemblyResult {
  const minOverlap = opts.minOverlap ?? 15;
  const maxOverlap = opts.maxOverlap ?? 80;
  const circular = opts.circular ?? true;
  const maxProducts = opts.maxProducts ?? 10;
  const errors: string[] = [];
  const warnings: string[] = [];

  if (parts.length < 2) return { products: [], errors: ["Homology assembly needs at least two fragments"], warnings };
  if (parts.length > 10) return { products: [], errors: ["Too many fragments to enumerate (limit is 10)"], warnings };

  const products: AssemblyProduct[] = [];
  const seen = new Set<string>();
  const n = parts.length;

  const search = (chain: { part: AssemblyPart; overlapWithPrevious: number }[], used: boolean[]) => {
    if (products.length >= maxProducts) return;
    if (chain.length === n) {
      let closing = 0;
      if (circular) {
        closing = overlapLength(chain[chain.length - 1]!.part.sequence, chain[0]!.part.sequence, minOverlap, maxOverlap);
        if (!closing) return;
      }
      const product = buildHomologyProduct(chain, circular, closing);
      const key = canonicalKey(product.sequence, circular);
      if (!seen.has(key)) {
        seen.add(key);
        products.push(product);
      }
      return;
    }
    for (let i = 0; i < n; i++) {
      if (used[i]) continue;
      const orientations = parts[i]!.allowFlip === false ? [parts[i]!] : [parts[i]!, flipPart(parts[i]!)];
      for (const oriented of orientations) {
        const overlap = overlapLength(chain[chain.length - 1]!.part.sequence, oriented.sequence, minOverlap, maxOverlap);
        if (!overlap) continue;
        used[i] = true;
        search([...chain, { part: oriented, overlapWithPrevious: overlap }], used);
        used[i] = false;
      }
    }
  };

  const first = parts[0]!;
  for (const oriented of first.allowFlip === false ? [first] : [first, flipPart(first)]) {
    const used = new Array(n).fill(false);
    used[0] = true;
    search([{ part: oriented, overlapWithPrevious: 0 }], used);
  }

  if (!products.length) {
    errors.push(`No arrangement of these fragments shares at least ${minOverlap} bp of terminal homology.`);
    errors.push(...describeMissingHomology(parts, minOverlap, maxOverlap));
  }
  for (const product of products) {
    for (const junction of product.junctions) {
      if (junction.sequence.length < 20) {
        warnings.push(`The ${junction.sequence.length} bp overlap between ${junction.leftPartId} and ${junction.rightPartId} is short; 20-40 bp is more reliable.`);
      }
    }
  }
  return { products, errors, warnings };
}

function describeMissingHomology(parts: readonly AssemblyPart[], minOverlap: number, maxOverlap: number): string[] {
  const notes: string[] = [];
  for (const part of parts) {
    const joinsAnything = parts.some(
      (other) =>
        other.id !== part.id &&
        (overlapLength(part.sequence, other.sequence, minOverlap, maxOverlap) > 0 ||
          overlapLength(part.sequence, reverseComplement(other.sequence), minOverlap, maxOverlap) > 0),
    );
    if (!joinsAnything) notes.push(`Fragment "${part.name}" shares no end homology with any other fragment.`);
  }
  return notes.slice(0, 4);
}

function buildHomologyProduct(
  chain: readonly { part: AssemblyPart; overlapWithPrevious: number }[],
  circular: boolean,
  closingOverlap: number,
): AssemblyProduct {
  let sequence = "";
  const order: AssemblyProduct["order"] = [];
  const features: BioFeature[] = [];
  const junctions: Junction[] = [];

  for (const [index, link] of chain.entries()) {
    // The shared homology is already present at the end of the previous fragment, so each
    // fragment after the first contributes only the bases beyond it.
    const overlap = index === 0 ? 0 : link.overlapWithPrevious;
    if (index > 0) {
      junctions.push({
        leftPartId: chain[index - 1]!.part.id,
        rightPartId: link.part.id,
        sequence: link.part.sequence.slice(0, overlap),
        kind: "homology",
        position: sequence.length - overlap,
      });
    }
    // The fragment's own base 0 sits `overlap` bases before the end of what is written so far.
    const partStart = sequence.length - overlap;
    sequence += link.part.sequence.slice(overlap);
    order.push({ partId: link.part.id, name: link.part.name, flipped: link.part.flipped ?? false, start: partStart, end: sequence.length });
    for (const feature of link.part.features ?? []) features.push(shiftFeature(feature, partStart));
  }

  if (circular && closingOverlap > 0) {
    // The final overlap is shared with the start of the product, so remove it from the end.
    sequence = sequence.slice(0, sequence.length - closingOverlap);
    junctions.push({
      leftPartId: chain[chain.length - 1]!.part.id,
      rightPartId: chain[0]!.part.id,
      sequence: chain[0]!.part.sequence.slice(0, closingOverlap),
      kind: "homology",
      position: sequence.length,
    });
  }
  return { sequence, isCircular: circular, features, order, junctions };
}

// ---------------------------------------------------------------------------------------------
// Workflows

export interface SourceMolecule {
  id: string;
  name: string;
  sequence: string;
  isCircular: boolean;
  features?: BioFeature[];
}

/** Turn a digest fragment into an assembly part, carrying over the features it contains. */
export function fragmentToPart(source: SourceMolecule, fragment: Fragment, index: number): AssemblyPart {
  const features = (source.features ?? [])
    .map((f) => clipFeature(f, fragment.range, source.sequence.length, source.isCircular))
    .filter((f): f is BioFeature => f !== null);
  return {
    id: `${source.id}:${index}`,
    name: `${source.name} ${fragment.length} bp`,
    sequence: fragment.sequence,
    leftEnd: fragment.leftEnd,
    rightEnd: fragment.rightEnd,
    features,
  };
}

/** Keep the part of a feature that falls inside a fragment, shifted into fragment coordinates. */
function clipFeature(feature: BioFeature, fragmentRange: Range, sourceLength: number, isCircular: boolean): BioFeature | null {
  const offsetOf = (index: number): number | null => {
    if (fragmentRange.end > fragmentRange.start) {
      return index >= fragmentRange.start && index < fragmentRange.end ? index - fragmentRange.start : null;
    }
    if (!isCircular) return null;
    if (index >= fragmentRange.start) return index - fragmentRange.start;
    if (index < fragmentRange.end) return sourceLength - fragmentRange.start + index;
    return null;
  };
  const segments: Range[] = [];
  for (const segment of feature.segments) {
    const start = offsetOf(segment.start);
    const endInclusive = offsetOf(segment.end - 1);
    if (start === null || endInclusive === null) continue;
    if (endInclusive + 1 <= start) continue;
    segments.push({ start, end: endInclusive + 1 });
  }
  return segments.length ? { ...feature, segments } : null;
}

export interface RestrictionCloneOptions {
  vector: SourceMolecule;
  insert: SourceMolecule;
  /** enzymes used to cut both molecules */
  enzymes: (Enzyme | string)[];
  /** which vector fragment to keep; by default the largest */
  vectorFragmentIndex?: number;
  /** which insert fragment to clone; by default the one between the cut sites */
  insertFragmentIndex?: number;
}

/**
 * Classic restriction cloning: digest a vector and an insert with the same enzymes, then ligate.
 */
export function restrictionClone(opts: RestrictionCloneOptions): AssemblyResult & { vectorFragment?: Fragment; insertFragment?: Fragment } {
  const enzymes = opts.enzymes.map((e) => (typeof e === "string" ? getEnzyme(e) : e)).filter((e): e is Enzyme => !!e);
  if (!enzymes.length) return { products: [], errors: ["No valid enzymes given"], warnings: [] };

  const vectorDigest = digest(opts.vector.sequence, opts.vector.isCircular, enzymes);
  const insertDigest = digest(opts.insert.sequence, opts.insert.isCircular, enzymes);
  const errors: string[] = [];

  if (vectorDigest.sites.length === 0) errors.push(`${enzymes.map((e) => e.name).join(" and ")} do not cut the vector.`);
  if (insertDigest.sites.length === 0) errors.push(`${enzymes.map((e) => e.name).join(" and ")} do not cut the insert.`);
  if (errors.length) return { products: [], errors, warnings: [] };

  const byLength = (list: Fragment[]) => [...list].sort((a, b) => b.length - a.length);
  const vectorFragment =
    opts.vectorFragmentIndex !== undefined ? vectorDigest.fragments[opts.vectorFragmentIndex] : byLength(vectorDigest.fragments)[0];
  // The insert is usually the fragment with two cut ends, not a natural end.
  const insertCandidates = insertDigest.fragments.filter((f) => f.leftEnd.enzyme && f.rightEnd.enzyme);
  const insertFragment =
    opts.insertFragmentIndex !== undefined
      ? insertDigest.fragments[opts.insertFragmentIndex]
      : byLength(insertCandidates.length ? insertCandidates : insertDigest.fragments)[0];

  if (!vectorFragment || !insertFragment) return { products: [], errors: ["Could not choose fragments to ligate"], warnings: [] };

  const result = assembleByEnds(
    [
      {
        ...fragmentToPart(opts.vector, vectorFragment, vectorDigest.fragments.indexOf(vectorFragment)),
        id: opts.vector.id,
        name: `${opts.vector.name} backbone`,
        allowFlip: false,
      },
      {
        ...fragmentToPart(opts.insert, insertFragment, insertDigest.fragments.indexOf(insertFragment)),
        id: opts.insert.id,
        name: `${opts.insert.name} insert`,
      },
    ],
    { circular: true },
  );
  return { ...result, vectorFragment, insertFragment };
}

export interface GoldenGateOptions {
  parts: SourceMolecule[];
  /** Type IIS enzyme, e.g. BsaI or BsmBI */
  enzyme: Enzyme | string;
  circular?: boolean;
}

/**
 * Golden Gate assembly: cut every part with one Type IIS enzyme and ligate the released
 * fragments by their defined overhangs.
 */
export function goldenGate(opts: GoldenGateOptions): AssemblyResult {
  const enzyme = typeof opts.enzyme === "string" ? getEnzyme(opts.enzyme) : opts.enzyme;
  if (!enzyme) return { products: [], errors: [`Unknown enzyme ${String(opts.enzyme)}`], warnings: [] };
  if (!enzyme.isTypeIIS) {
    return { products: [], errors: [`${enzyme.name} is not a Type IIS enzyme; Golden Gate needs one that cuts outside its site.`], warnings: [] };
  }

  const errors: string[] = [];
  const warnings: string[] = [];
  const assemblyParts: AssemblyPart[] = [];

  for (const source of opts.parts) {
    const { sites, fragments } = digest(source.sequence, source.isCircular, [enzyme]);
    if (sites.length < 2) {
      errors.push(`${enzyme.name} cuts "${source.name}" ${sites.length} time(s); each part needs two sites to release an insert.`);
      continue;
    }
    // Keep fragments released by the enzyme at both ends: those carry the designed overhangs.
    const released = fragments.filter((f) => f.leftEnd.enzyme === enzyme.name && f.rightEnd.enzyme === enzyme.name);
    if (!released.length) {
      errors.push(`No fragment of "${source.name}" is flanked by ${enzyme.name} sites on both sides.`);
      continue;
    }
    const chosen = released.sort((a, b) => b.length - a.length)[0]!;
    if (released.length > 1) {
      warnings.push(`"${source.name}" releases ${released.length} fragments; the ${chosen.length} bp one was used.`);
    }
    // Each source contributes exactly one fragment, so keep the user's own id and name.
    assemblyParts.push({ ...fragmentToPart(source, chosen, fragments.indexOf(chosen)), id: source.id, name: source.name });
  }

  if (errors.length) return { products: [], errors, warnings };

  const overhangs = assemblyParts.flatMap((p) => [p.leftEnd.overhang, p.rightEnd.overhang]);
  const duplicates = overhangs.filter((o, i) => o && overhangs.indexOf(o) !== i);
  if (new Set(duplicates).size) {
    warnings.push(`Overhang(s) ${[...new Set(duplicates)].join(", ")} appear more than once, so parts may assemble in several orders.`);
  }

  const result = assembleByEnds(assemblyParts, { circular: opts.circular ?? true });
  return { ...result, warnings: [...warnings, ...result.warnings] };
}

export interface GibsonCloneOptions {
  fragments: SourceMolecule[];
  minOverlap?: number;
  circular?: boolean;
}

/** Gibson assembly of linear fragments that already carry designed overlaps. */
export function gibsonAssembly(opts: GibsonCloneOptions): AssemblyResult {
  const parts: AssemblyPart[] = opts.fragments.map((f) => ({
    id: f.id,
    name: f.name,
    sequence: f.sequence,
    leftEnd: BLUNT,
    rightEnd: BLUNT,
    features: f.features,
  }));
  return assembleByHomology(parts, { minOverlap: opts.minOverlap ?? 15, circular: opts.circular ?? true });
}

/**
 * Primer tails that give a fragment the homology Gibson assembly needs.
 * Returns the bases to prepend to each primer so the PCR product overlaps its neighbours.
 */
export function gibsonOverlapTails(
  upstream: string,
  insert: string,
  downstream: string,
  overlap = 25,
): { forwardTail: string; reverseTail: string } {
  return {
    // The forward primer carries the end of the upstream fragment.
    forwardTail: upstream.slice(-overlap),
    // The reverse primer carries the reverse complement of the start of the downstream fragment.
    reverseTail: reverseComplement(downstream.slice(0, overlap)),
  };
}
