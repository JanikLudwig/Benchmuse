/**
 * Auto-annotation: scan a sequence for known parts and for open reading frames, and propose
 * features the user can accept. Nothing is written without the caller's say-so.
 */

import type { BioFeature } from "../formats/types";
import { rangesOverlap, type Range } from "../range";
import { findMatches, findOrfs, type Orf } from "../seq";
import { PARTS, type Part } from "./library";

export interface AnnotationSuggestion extends BioFeature {
  /** why this was proposed */
  source: "library" | "orf";
  /** library part name or ORF length, for the UI */
  detail: string;
}

export interface AnnotateOptions {
  /** restrict to these part names */
  parts?: readonly Part[];
  /** also propose ORFs above this length in amino acids (0 disables) */
  minOrfAa?: number;
  /** skip suggestions overlapping these existing features */
  existing?: readonly { segments: Range[] }[];
}

/**
 * Find library parts and (optionally) ORFs in a sequence.
 *
 * Suggestions overlapping an existing feature of the same span are dropped, so re-running
 * auto-annotation on an already-annotated plasmid does not create duplicates.
 */
export function suggestAnnotations(seq: string, isCircular: boolean, opts: AnnotateOptions = {}): AnnotationSuggestion[] {
  const library = opts.parts ?? PARTS;
  const minOrfAa = opts.minOrfAa ?? 0;
  const suggestions: AnnotationSuggestion[] = [];

  for (const part of library) {
    if (part.sequence.length < 6 || part.sequence.length > seq.length) continue;
    for (const match of findMatches(seq, part.sequence, isCircular, { bothStrands: true })) {
      suggestions.push({
        name: part.name,
        type: part.type,
        strand: match.strand,
        segments: splitWrapped(match.range, seq.length),
        qualifiers: {
          ...(part.description && { note: [part.description] }),
          ...(part.peptide && { translation: [part.peptide] }),
        },
        color: part.color,
        source: "library",
        detail: part.description ?? part.name,
      });
    }
  }

  if (minOrfAa > 0) {
    for (const orf of findOrfs(seq, isCircular, { minAaLength: minOrfAa })) {
      suggestions.push(orfToSuggestion(orf, seq.length));
    }
  }

  // Prefer the longest explanation for any given stretch, and never duplicate what exists.
  const existing = opts.existing ?? [];
  const kept: AnnotationSuggestion[] = [];
  const bySize = [...suggestions].sort((a, b) => spanOf(b) - spanOf(a));
  for (const candidate of bySize) {
    const duplicatesExisting = existing.some((e) => sameSpan(e.segments, candidate.segments));
    const duplicatesKept = kept.some((k) => k.name === candidate.name && sameSpan(k.segments, candidate.segments));
    const insideBigger =
      candidate.source === "orf" &&
      kept.some((k) => k.source === "orf" && k.strand === candidate.strand && contains(k.segments, candidate.segments, seq.length, isCircular));
    if (!duplicatesExisting && !duplicatesKept && !insideBigger) kept.push(candidate);
  }
  return kept.sort((a, b) => (a.segments[0]?.start ?? 0) - (b.segments[0]?.start ?? 0));
}

function orfToSuggestion(orf: Orf, seqLength: number): AnnotationSuggestion {
  return {
    name: `ORF (${orf.aaLength} aa)`,
    type: "CDS",
    strand: orf.strand,
    segments: splitWrapped(orf.range, seqLength),
    qualifiers: { translation: [orf.protein], codon_start: ["1"] },
    color: "#6366f1",
    source: "orf",
    detail: `${orf.aaLength} aa open reading frame`,
  };
}

/** A range that wraps the origin becomes two segments, which is how GenBank represents it. */
function splitWrapped(range: Range, seqLength: number): Range[] {
  if (range.end > range.start) return [range];
  return [
    { start: range.start, end: seqLength },
    { start: 0, end: range.end },
  ].filter((s) => s.end > s.start);
}

const spanOf = (f: { segments: Range[] }) => f.segments.reduce((n, s) => n + (s.end - s.start), 0);

function sameSpan(a: readonly Range[], b: readonly Range[]): boolean {
  return a.length === b.length && a.every((s, i) => s.start === b[i]!.start && s.end === b[i]!.end);
}

function contains(outer: readonly Range[], inner: readonly Range[], seqLength: number, isCircular: boolean): boolean {
  return inner.every((i) => outer.some((o) => rangesOverlap(o, i, seqLength, isCircular) && o.start <= i.start && o.end >= i.end));
}
