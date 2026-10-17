/**
 * Range arithmetic for linear and circular sequences.
 *
 * Ranges are 0-based half-open `[start, end)`. On a circular sequence `end <= start` means the
 * range wraps the origin, so `{start: 0, end: 0}` on a circular molecule is the whole circle.
 * On a linear sequence `end` must be greater than `start`.
 *
 * UI and file formats use 1-based inclusive coordinates; convert at the boundary with
 * `toDisplay` / `fromDisplay` rather than carrying two conventions through the code.
 */

export interface Range {
  start: number;
  end: number;
}

export interface Strand {
  /** 1 = top/forward, -1 = bottom/reverse, 0 = unstranded */
  strand: 1 | -1 | 0;
}

export function wraps(range: Range): boolean {
  return range.end <= range.start;
}

/** Number of bases covered, accounting for origin wrap on circular sequences. */
export function rangeLength(range: Range, seqLength: number, isCircular: boolean): number {
  if (!wraps(range)) return range.end - range.start;
  if (!isCircular) return 0;
  return seqLength - range.start + range.end;
}

/** The one or two linear segments a range covers, in 5'->3' order along the top strand. */
export function segments(range: Range, seqLength: number, isCircular: boolean): Range[] {
  if (!wraps(range)) return [{ start: range.start, end: range.end }];
  if (!isCircular) return [];
  const out: Range[] = [];
  if (range.start < seqLength) out.push({ start: range.start, end: seqLength });
  if (range.end > 0) out.push({ start: 0, end: range.end });
  return out;
}

/** Modulo that returns a non-negative result, for walking around a circular sequence. */
export function wrapIndex(index: number, seqLength: number): number {
  if (seqLength <= 0) return 0;
  return ((index % seqLength) + seqLength) % seqLength;
}

export function rangeContains(range: Range, index: number, seqLength: number, isCircular: boolean): boolean {
  return segments(range, seqLength, isCircular).some((s) => index >= s.start && index < s.end);
}

export function rangesOverlap(a: Range, b: Range, seqLength: number, isCircular: boolean): boolean {
  const as = segments(a, seqLength, isCircular);
  const bs = segments(b, seqLength, isCircular);
  return as.some((x) => bs.some((y) => x.start < y.end && y.start < x.end));
}

/** 1-based inclusive `[first, last]` as shown in the UI, GenBank and primer reports. */
export function toDisplay(range: Range, seqLength: number, isCircular: boolean): { first: number; last: number } {
  const length = rangeLength(range, seqLength, isCircular);
  return { first: range.start + 1, last: length === 0 ? range.start : wrapIndex(range.start + length - 1, seqLength) + 1 };
}

export function fromDisplay(first: number, last: number, seqLength: number): Range {
  const start = first - 1;
  const end = last >= first ? last : last % Math.max(seqLength, 1);
  return { start, end };
}

/** Clamp a linear range into `[0, seqLength]`, returning null if nothing is left. */
export function clampRange(range: Range, seqLength: number): Range | null {
  const start = Math.max(0, Math.min(range.start, seqLength));
  const end = Math.max(0, Math.min(range.end, seqLength));
  return end > start ? { start, end } : null;
}

/**
 * Shift a range through an edit that replaced `[editStart, editEnd)` with `insertedLength` bases.
 *
 * Returns the moved range, or null when the edit removed the range entirely. Ranges that
 * partially overlap the edit are truncated to the surviving part, which is what sequence editors
 * do to features when you delete across their boundary.
 */
export function shiftRange(
  range: Range,
  edit: { start: number; end: number; insertedLength: number },
  seqLength: number,
  isCircular: boolean,
): Range | null {
  const delta = edit.insertedLength - (edit.end - edit.start);
  const pieces = segments(range, seqLength, isCircular);
  if (!pieces.length) return null;

  const moved: Range[] = [];
  for (const piece of pieces) {
    // Split the piece around the edited window, keeping only what survives.
    const beforeEnd = Math.min(piece.end, edit.start);
    const afterStart = Math.max(piece.start, edit.end);
    const keepBefore = beforeEnd > piece.start ? { start: piece.start, end: beforeEnd } : null;
    const keepAfter = piece.end > afterStart ? { start: afterStart + delta, end: piece.end + delta } : null;

    if (keepBefore && keepAfter) {
      // The edit fell inside the piece: span the replacement so the feature stays contiguous.
      moved.push({ start: keepBefore.start, end: keepAfter.end });
    } else if (keepBefore) {
      moved.push(keepBefore);
    } else if (keepAfter) {
      moved.push(keepAfter);
    }
  }
  if (!moved.length) return null;

  const newLength = seqLength + delta;
  if (moved.length === 1) {
    const only = moved[0]!;
    const clamped = clampRange(only, newLength);
    return clamped;
  }
  // Two surviving pieces means the range still wraps the origin.
  const tail = moved.find((m) => m.end >= newLength || m.start > (moved[0]?.start ?? 0));
  const head = moved.find((m) => m !== tail);
  if (!tail || !head) return clampRange(moved[0]!, newLength);
  return { start: Math.min(tail.start, newLength - 1), end: Math.min(head.end, newLength) };
}
