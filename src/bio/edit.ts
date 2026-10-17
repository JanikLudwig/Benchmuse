/**
 * Sequence editing that keeps annotations attached to the right bases.
 *
 * Every edit is expressed as "replace `[start, end)` with these bases", which covers insertion,
 * deletion and replacement. Features are moved, trimmed or dropped to match, the way a sequence
 * editor must behave when a scientist deletes across a feature boundary.
 */

import type { BioFeature } from "./formats/types";
import { shiftRange, type Range } from "./range";
import { reverseComplement } from "./seq";

export interface SequenceEdit {
  /** half-open range of the current sequence to replace */
  start: number;
  end: number;
  /** bases to put in its place; empty for a deletion */
  insert: string;
}

export interface EditResult {
  sequence: string;
  features: BioFeature[];
  /** features that were removed entirely because the edit deleted them */
  removed: BioFeature[];
  /** features whose extent changed */
  truncated: BioFeature[];
}

/**
 * Apply edits to a sequence and move its features.
 *
 * Edits are applied from the 3' end backwards so earlier coordinates stay valid, and they may
 * not overlap each other.
 */
export function applyEdits(
  sequence: string,
  features: readonly BioFeature[],
  edits: readonly SequenceEdit[],
  isCircular: boolean,
): EditResult {
  const ordered = [...edits].sort((a, b) => b.start - a.start);
  for (let i = 1; i < ordered.length; i++) {
    if (ordered[i]!.end > ordered[i - 1]!.start) throw new Error("Edits overlap; apply them one at a time");
  }

  let result = sequence;
  let current: BioFeature[] = features.map((f) => ({ ...f, segments: f.segments.map((s) => ({ ...s })) }));
  const removed: BioFeature[] = [];
  const truncated: BioFeature[] = [];

  for (const edit of ordered) {
    const start = Math.max(0, Math.min(edit.start, result.length));
    const end = Math.max(start, Math.min(edit.end, result.length));
    const before = result;
    result = result.slice(0, start) + edit.insert + result.slice(end);

    const next: BioFeature[] = [];
    for (const feature of current) {
      const movedSegments: Range[] = [];
      let changed = false;
      for (const segment of feature.segments) {
        const moved = shiftRange(segment, { start, end, insertedLength: edit.insert.length }, before.length, isCircular);
        if (!moved) {
          changed = true;
          continue;
        }
        if (moved.start !== segment.start || moved.end !== segment.end) changed = true;
        movedSegments.push(moved);
      }
      if (!movedSegments.length) {
        removed.push(feature);
        continue;
      }
      if (changed && !truncated.includes(feature)) truncated.push(feature);
      next.push({ ...feature, segments: movedSegments });
    }
    current = next;
  }

  return { sequence: result, features: current, removed, truncated };
}

/** Insert bases at a position. */
export function insertBases(sequence: string, features: readonly BioFeature[], at: number, bases: string, isCircular: boolean): EditResult {
  return applyEdits(sequence, features, [{ start: at, end: at, insert: bases }], isCircular);
}

/** Delete a range. */
export function deleteRange(sequence: string, features: readonly BioFeature[], range: Range, isCircular: boolean): EditResult {
  return applyEdits(sequence, features, [{ start: range.start, end: range.end, insert: "" }], isCircular);
}

/** Replace a range with new bases. */
export function replaceRange(
  sequence: string,
  features: readonly BioFeature[],
  range: Range,
  bases: string,
  isCircular: boolean,
): EditResult {
  return applyEdits(sequence, features, [{ start: range.start, end: range.end, insert: bases }], isCircular);
}

/**
 * Reverse-complement a whole molecule, flipping every feature with it.
 */
export function reverseComplementSequence(sequence: string, features: readonly BioFeature[]): { sequence: string; features: BioFeature[] } {
  const length = sequence.length;
  return {
    sequence: reverseComplement(sequence),
    features: features.map((f) => ({
      ...f,
      strand: f.strand === 0 ? 0 : ((f.strand * -1) as 1 | -1),
      segments: [...f.segments].reverse().map((s) => ({ start: length - s.end, end: length - s.start })),
      partial5: f.partial3,
      partial3: f.partial5,
    })),
  };
}

/**
 * Rotate a circular sequence so that `newOrigin` becomes position 0.
 *
 * Features that end up crossing the new origin are split into two segments, which is how
 * GenBank represents them.
 */
export function setOrigin(
  sequence: string,
  features: readonly BioFeature[],
  newOrigin: number,
): { sequence: string; features: BioFeature[] } {
  const L = sequence.length;
  const shift = ((newOrigin % L) + L) % L;
  if (shift === 0) return { sequence, features: features.map((f) => ({ ...f })) };
  const rotated = sequence.slice(shift) + sequence.slice(0, shift);

  const move = (index: number) => ((index - shift) % L + L) % L;
  const moved = features.map((feature) => {
    const segments: Range[] = [];
    for (const segment of feature.segments) {
      const start = move(segment.start);
      const end = move(segment.end) === 0 && segment.end !== 0 ? L : move(segment.end);
      if (end > start) segments.push({ start, end });
      else segments.push({ start, end: L }, { start: 0, end });
    }
    return { ...feature, segments: segments.filter((s) => s.end > s.start) };
  });
  return { sequence: rotated, features: moved };
}
