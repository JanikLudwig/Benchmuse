/**
 * GenBank/EMBL feature location parser and writer.
 *
 * Handles the grammar used in real files:
 *   `123..456`, `complement(123..456)`, `join(12..78,134..202)`,
 *   `complement(join(...))`, `join(complement(..),..)`, `<1..206`, `12^13`, `order(...)`,
 *   and remote references like `J00194.1:1..100` (kept as a note, not as coordinates).
 *
 * GenBank coordinates are 1-based inclusive; the ranges returned here are 0-based half-open.
 */

import type { Range } from "../range";

export interface ParsedLocation {
  segments: Range[];
  strand: 1 | -1;
  /** the 5' end is incomplete (`<` in GenBank) */
  partial5: boolean;
  /** the 3' end is incomplete (`>` in GenBank) */
  partial3: boolean;
  /** `order(...)` means the segments are not known to be contiguous */
  ordered: boolean;
  /** `12^13`: a position between two bases, used for insertion sites */
  between: boolean;
  /** accessions referenced by the location, if any */
  remote: string[];
}

class Cursor {
  constructor(readonly text: string, public pos = 0) {}
  peek(): string { return this.text[this.pos] ?? ""; }
  eat(expected?: string): string {
    const ch = this.text[this.pos] ?? "";
    if (expected && ch !== expected) throw new Error(`expected '${expected}' at ${this.pos} in "${this.text}"`);
    this.pos++;
    return ch;
  }
  match(word: string): boolean {
    if (this.text.startsWith(word, this.pos)) { this.pos += word.length; return true; }
    return false;
  }
  skipSpace(): void { while (/\s/.test(this.peek())) this.pos++; }
}

interface Node {
  segments: Range[];
  complement: boolean;
  partial5: boolean;
  partial3: boolean;
  ordered: boolean;
  between: boolean;
  remote: string[];
}

function parseNode(c: Cursor): Node {
  c.skipSpace();
  if (c.match("complement(")) {
    const inner = parseNode(c);
    c.skipSpace();
    c.eat(")");
    // complement() flips the strand and the 5'/3' sense of partial ends.
    return { ...inner, complement: !inner.complement, partial5: inner.partial3, partial3: inner.partial5 };
  }
  const ordered = c.text.startsWith("order(", c.pos);
  if (ordered || c.text.startsWith("join(", c.pos)) {
    c.pos += ordered ? 6 : 5;
    const parts: Node[] = [];
    for (;;) {
      parts.push(parseNode(c));
      c.skipSpace();
      if (c.peek() === ",") { c.eat(","); continue; }
      c.eat(")");
      break;
    }
    // A join of complemented parts is a feature on the bottom strand; its segments are listed
    // 3'->5' in the file, so reverse them to keep top-strand order.
    const anyComplement = parts.some((p) => p.complement);
    const segments = parts.flatMap((p) => p.segments);
    return {
      segments: anyComplement ? [...segments].reverse() : segments,
      complement: anyComplement,
      partial5: parts[0]?.partial5 ?? false,
      partial3: parts[parts.length - 1]?.partial3 ?? false,
      ordered,
      between: false,
      remote: parts.flatMap((p) => p.remote),
    };
  }
  return parseSpan(c);
}

function parseSpan(c: Cursor): Node {
  c.skipSpace();
  const remote: string[] = [];
  // Remote reference: ACCESSION.VERSION:location
  const remoteMatch = /^([A-Za-z_][\w.]*):/.exec(c.text.slice(c.pos));
  if (remoteMatch) {
    remote.push(remoteMatch[1]!);
    c.pos += remoteMatch[0].length;
  }

  const readPos = (): { value: number; partial5: boolean; partial3: boolean } => {
    let partial5 = false;
    let partial3 = false;
    if (c.peek() === "<") { c.eat("<"); partial5 = true; }
    if (c.peek() === ">") { c.eat(">"); partial3 = true; }
    const digits = /^\d+/.exec(c.text.slice(c.pos));
    if (!digits) throw new Error(`expected a number at ${c.pos} in "${c.text}"`);
    c.pos += digits[0].length;
    return { value: Number(digits[0]), partial5, partial3 };
  };

  const first = readPos();
  // A single-base position inside a span can itself be a range: (102.110)
  if (c.peek() === "." && c.text[c.pos + 1] !== ".") {
    c.eat(".");
    const alt = readPos();
    return node([{ start: first.value - 1, end: alt.value }], first.partial5, alt.partial3, remote);
  }
  if (c.peek() === "^") {
    c.eat("^");
    const next = readPos();
    // Between two bases: a zero-width position, represented as the gap after `first`.
    return { ...node([{ start: first.value, end: next.value - 1 }], false, false, remote), between: true };
  }
  if (c.match("..")) {
    const last = readPos();
    return node([{ start: first.value - 1, end: last.value }], first.partial5, last.partial3, remote);
  }
  // Bare single base.
  return node([{ start: first.value - 1, end: first.value }], first.partial5, first.partial3, remote);
}

function node(segments: Range[], partial5: boolean, partial3: boolean, remote: string[]): Node {
  return { segments, complement: false, partial5, partial3, ordered: false, between: false, remote };
}

export function parseLocation(text: string): ParsedLocation {
  const cleaned = text.replace(/\s+/g, "");
  const cursor = new Cursor(cleaned);
  const parsed = parseNode(cursor);
  return {
    segments: parsed.segments,
    strand: parsed.complement ? -1 : 1,
    partial5: parsed.partial5,
    partial3: parsed.partial3,
    ordered: parsed.ordered,
    between: parsed.between,
    remote: parsed.remote,
  };
}

/** Format segments back into GenBank location syntax. */
export function formatLocation(location: {
  segments: Range[];
  strand: number;
  partial5?: boolean;
  partial3?: boolean;
  ordered?: boolean;
}): string {
  if (!location.segments.length) return "";
  const reverse = location.strand === -1;
  // Segments are always written in ascending coordinate order; `complement(...)` wraps the whole
  // join, which is what reverses the reading direction.
  const spans = location.segments.map((s, i) => {
    const isFirst = i === 0;
    const isLast = i === location.segments.length - 1;
    // `<` marks the lowest coordinate and `>` the highest, so which feature end they represent
    // depends on the strand.
    const lead = isFirst && (reverse ? location.partial3 : location.partial5) ? "<" : "";
    const tail = isLast && (reverse ? location.partial5 : location.partial3) ? ">" : "";
    const first = s.start + 1;
    const last = s.end;
    return first === last && !lead && !tail ? `${first}` : `${lead}${first}..${tail}${last}`;
  });
  const joined = spans.length === 1 ? spans[0]! : `${location.ordered ? "order" : "join"}(${spans.join(",")})`;
  return reverse ? `complement(${joined})` : joined;
}
