/**
 * GenBank flat-file reader and writer.
 *
 * Parsing is deliberately lenient: files written by SnapGene, ApE, Geneious and Benchling all
 * deviate from the NCBI column spec in small ways, and a sequence tool that rejects a real
 * customer file is useless. Anything unparseable becomes a warning, never a thrown error.
 */

import { guessKind } from "../alphabet";
import type { Range } from "../range";
import { formatLocation, parseLocation } from "./location";
import type { BioFeature, ParseResult, ParseWarning, SequenceRecord } from "./types";

const NAME_QUALIFIERS = ["label", "standard_name", "gene", "product", "locus_tag", "note", "organism"];
const COLOR_QUALIFIERS = ["ApEinfo_fwdcolor", "ApEinfo_revcolor", "color", "Color", "colour"];
/** Qualifiers whose wrapped continuation lines are joined without a space. */
const UNSPACED_QUALIFIERS = new Set(["translation", "anticodon", "transl_except", "rpt_unit_seq"]);

export function isGenBank(text: string): boolean {
  return /^LOCUS\s+/m.test(text.slice(0, 4000));
}

export function parseGenBank(text: string): ParseResult {
  const warnings: ParseWarning[] = [];
  const records: SequenceRecord[] = [];
  const lines = text.split(/\r\n|\r|\n/);

  let current: string[] = [];
  for (const line of lines) {
    if (line.startsWith("//")) {
      if (current.length) records.push(parseRecord(current, warnings));
      current = [];
      continue;
    }
    if (line.startsWith("LOCUS") && current.length) {
      // Some files omit the // terminator between records.
      records.push(parseRecord(current, warnings));
      current = [];
    }
    current.push(line);
  }
  if (current.some((l) => l.trim())) records.push(parseRecord(current, warnings));
  return { records, warnings };
}

function parseRecord(lines: string[], warnings: ParseWarning[]): SequenceRecord {
  const record: SequenceRecord = {
    name: "",
    kind: "dna",
    isCircular: false,
    residues: "",
    features: [],
    format: "genbank",
  };
  const comments: string[] = [];

  let section: "none" | "features" | "origin" = "none";
  let pendingFeature: { type: string; location: string; qualifiers: [string, string][] } | null = null;
  let pendingQualifier: { key: string; value: string; quoted: boolean } | null = null;
  const residues: string[] = [];

  const flushQualifier = () => {
    if (pendingFeature && pendingQualifier) pendingFeature.qualifiers.push([pendingQualifier.key, pendingQualifier.value]);
    pendingQualifier = null;
  };
  const flushFeature = () => {
    flushQualifier();
    if (pendingFeature) {
      const built = buildFeature(pendingFeature, warnings);
      if (built) record.features.push(built);
    }
    pendingFeature = null;
  };

  for (const [index, raw] of lines.entries()) {
    const line = raw.replace(/\s+$/, "");
    if (!line.trim()) continue;

    if (section === "origin") {
      residues.push(line.replace(/[\s\d]/g, ""));
      continue;
    }

    const keyword = /^(\w+)/.exec(line);
    const isTopLevel = !line.startsWith(" ") && keyword;

    if (isTopLevel) {
      flushFeature();
      const key = keyword[1]!.toUpperCase();
      const value = line.slice(keyword[1]!.length).trim();
      switch (key) {
        case "LOCUS":
          applyLocus(record, value, warnings, index);
          section = "none";
          break;
        case "DEFINITION":
          record.description = value;
          section = "none";
          break;
        case "ACCESSION":
          record.accession = value.split(/\s+/)[0];
          section = "none";
          break;
        case "VERSION":
          record.version = value.split(/\s+/)[0];
          section = "none";
          break;
        case "SOURCE":
          if (!record.organism) record.organism = value;
          section = "none";
          break;
        case "COMMENT":
          if (value) comments.push(value);
          section = "none";
          break;
        case "FEATURES":
          section = "features";
          break;
        case "ORIGIN":
          section = "origin";
          break;
        default:
          section = "none";
      }
      continue;
    }

    if (section === "features") {
      // A feature header is indented ~5 spaces: "     CDS             146..469"
      const header = /^ {1,10}(\S+)\s+(\S.*)$/.exec(line);
      const isQualifierLine = /^\s{10,}\//.test(line);
      if (header && !isQualifierLine) {
        flushFeature();
        pendingFeature = { type: header[1]!, location: header[2]!.trim(), qualifiers: [] };
        continue;
      }
      if (!pendingFeature) continue;

      const qualifier = /^\s*\/([^=\s]+)(?:=(.*))?$/.exec(line);
      if (qualifier && !pendingQualifier?.quoted) {
        flushQualifier();
        const key = qualifier[1]!;
        const rawValue = qualifier[2];
        if (rawValue === undefined) {
          pendingFeature.qualifiers.push([key, ""]);
          continue;
        }
        const quoted = rawValue.startsWith('"');
        const body = quoted ? rawValue.slice(1) : rawValue;
        if (quoted && !body.endsWith('"')) {
          pendingQualifier = { key, value: body, quoted: true };
        } else {
          pendingFeature.qualifiers.push([key, quoted ? body.replace(/"$/, "") : body]);
        }
        continue;
      }
      if (pendingQualifier) {
        const continuation = line.trim();
        const joiner = UNSPACED_QUALIFIERS.has(pendingQualifier.key) ? "" : " ";
        if (continuation.endsWith('"')) {
          pendingQualifier.value += joiner + continuation.slice(0, -1);
          flushQualifier();
        } else {
          pendingQualifier.value += joiner + continuation;
        }
        continue;
      }
      // An unlabelled continuation of a long location line.
      if (/^\s{10,}\S/.test(line) && pendingFeature && !pendingFeature.qualifiers.length) {
        pendingFeature.location += line.trim();
      }
      continue;
    }

    if (section === "none" && line.startsWith(" ") && /ORGANISM/.test(line)) {
      record.organism = line.replace(/^\s*ORGANISM\s*/, "").trim();
    }
  }
  flushFeature();

  record.residues = residues.join("").replace(/[^A-Za-z*-]/g, "");
  if (!record.residues.length) warnings.push({ message: `Record "${record.name || "(unnamed)"}" has no sequence` });
  if (record.kind === "dna" && record.residues.length) {
    // Trust an explicit LOCUS molecule type, but fall back to composition when it was missing.
    record.kind = guessKind(record.residues);
  }
  if (comments.length) record.comments = comments;
  if (!record.name) record.name = record.accession ?? "Untitled";
  return record;
}

function applyLocus(record: SequenceRecord, value: string, warnings: ParseWarning[], line: number): void {
  const tokens = value.split(/\s+/).filter(Boolean);
  record.name = tokens[0] ?? "";
  record.isCircular = /\bcircular\b/i.test(value);
  if (/\b(aa|PRT)\b/i.test(value)) record.kind = "aa";
  const lengthToken = tokens.findIndex((t) => /^\d+$/.test(t));
  if (lengthToken === -1) warnings.push({ message: "LOCUS line has no sequence length", line: line + 1 });
}

function buildFeature(
  raw: { type: string; location: string; qualifiers: [string, string][] },
  warnings: ParseWarning[],
): BioFeature | null {
  let segments: Range[];
  let strand: 1 | -1 | 0 = 1;
  let partial5 = false;
  let partial3 = false;
  try {
    const parsed = parseLocation(raw.location);
    segments = parsed.segments;
    strand = parsed.strand;
    partial5 = parsed.partial5;
    partial3 = parsed.partial3;
  } catch (e) {
    warnings.push({ message: `Skipped ${raw.type} feature with unparseable location "${raw.location}"` });
    return null;
  }
  if (!segments.length) return null;

  const qualifiers: Record<string, string[]> = {};
  for (const [key, value] of raw.qualifiers) (qualifiers[key] ??= []).push(value);

  const nameKey = NAME_QUALIFIERS.find((k) => qualifiers[k]?.[0]?.trim());
  const name = nameKey ? qualifiers[nameKey]![0]!.trim() : raw.type;

  return {
    name: name.length > 120 ? `${name.slice(0, 117)}…` : name,
    type: raw.type,
    strand,
    segments,
    qualifiers,
    color: extractColor(qualifiers),
    ...(partial5 && { partial5 }),
    ...(partial3 && { partial3 }),
  };
}

function extractColor(qualifiers: Record<string, string[]>): string | undefined {
  for (const key of COLOR_QUALIFIERS) {
    const value = qualifiers[key]?.[0];
    if (value && /^#?[0-9a-f]{6}$/i.test(value.trim())) {
      const v = value.trim();
      return v.startsWith("#") ? v.toLowerCase() : `#${v.toLowerCase()}`;
    }
  }
  // SnapGene writes colors inside a note: /note="color: #ff0000; direction: RIGHT"
  for (const note of qualifiers.note ?? []) {
    const m = /colou?r:\s*(#[0-9a-f]{6})/i.exec(note);
    if (m) return m[1]!.toLowerCase();
  }
  return undefined;
}

// ---------------------------------------------------------------------------------------------
// Writing

const QUALIFIER_INDENT = " ".repeat(21);
const LINE_WIDTH = 79;

export interface WriteGenBankOptions {
  /** ISO date to stamp on the LOCUS line; defaults to today */
  date?: Date;
  division?: string;
  /** keep qualifiers that were imported verbatim; off by default to avoid stale cross-references */
  includeUnknownQualifiers?: boolean;
}

export function writeGenBank(record: SequenceRecord, opts: WriteGenBankOptions = {}): string {
  const isProtein = record.kind === "aa";
  const unit = isProtein ? "aa" : "bp";
  const molecule = isProtein ? "PRT" : "DNA";
  const topology = record.isCircular ? "circular" : "linear";
  const division = opts.division ?? "SYN";
  const date = formatDate(opts.date ?? new Date());
  const name = (record.name || "Untitled").replace(/\s+/g, "_").slice(0, 16);

  const out: string[] = [];
  out.push(
    `LOCUS       ${name.padEnd(16)} ${String(record.residues.length).padStart(11)} ${unit}    ${molecule.padEnd(6)}  ${topology.padEnd(8)} ${division} ${date}`,
  );
  out.push(wrapField("DEFINITION", record.description || record.name || "."));
  if (record.accession) out.push(wrapField("ACCESSION", record.accession));
  if (record.version) out.push(wrapField("VERSION", record.version));
  out.push(wrapField("KEYWORDS", "."));
  if (record.organism) {
    out.push(wrapField("SOURCE", record.organism));
    out.push(`  ORGANISM  ${record.organism}`);
  }
  for (const comment of record.comments ?? []) out.push(wrapField("COMMENT", comment));

  out.push("FEATURES             Location/Qualifiers");
  for (const feature of record.features) {
    out.push(...writeFeature(feature, opts));
  }

  out.push("ORIGIN");
  out.push(...writeOrigin(record.residues));
  out.push("//");
  return out.join("\n") + "\n";
}

function writeFeature(feature: BioFeature, opts: WriteGenBankOptions): string[] {
  const location = formatLocation(feature);
  const head = `     ${feature.type.padEnd(16).slice(0, 16)}`;
  const lines = wrapLocation(head, location);

  const emitted = new Set<string>();
  const push = (key: string, value: string, quoted = true) => {
    const text = quoted ? `/${key}="${value}"` : `/${key}=${value}`;
    lines.push(...wrapQualifier(text, key));
  };

  // /label first: that is what viewers show, and what we resolved the name from.
  push("label", feature.name);
  emitted.add("label");

  for (const [key, values] of Object.entries(feature.qualifiers)) {
    if (emitted.has(key)) continue;
    if (!opts.includeUnknownQualifiers && !PRESERVED_QUALIFIERS.has(key)) continue;
    for (const value of values) {
      if (value === "") lines.push(`${QUALIFIER_INDENT}/${key}`);
      else push(key, value, !/^\d+$/.test(value));
    }
    emitted.add(key);
  }
  if (feature.color) {
    push("ApEinfo_fwdcolor", feature.color);
    push("ApEinfo_revcolor", feature.color);
  }
  return lines;
}

/** Qualifiers that carry meaning we want to round-trip even in "clean" exports. */
const PRESERVED_QUALIFIERS = new Set([
  "gene", "product", "note", "codon_start", "transl_table", "translation", "function",
  "standard_name", "locus_tag", "protein_id", "db_xref", "EC_number", "organism", "mol_type",
  "regulatory_class", "bound_moiety", "rpt_type", "direction", "pseudo", "experiment", "inference",
]);

function wrapLocation(head: string, location: string): string[] {
  const available = LINE_WIDTH - head.length;
  if (location.length <= available) return [`${head}${location}`];
  // Break long joins after commas.
  const parts = location.split(/(?<=,)/);
  const lines: string[] = [];
  let currentLine = head;
  let currentWidth = head.length;
  for (const part of parts) {
    if (currentWidth + part.length > LINE_WIDTH && currentWidth > QUALIFIER_INDENT.length) {
      lines.push(currentLine);
      currentLine = QUALIFIER_INDENT;
      currentWidth = QUALIFIER_INDENT.length;
    }
    currentLine += part;
    currentWidth += part.length;
  }
  lines.push(currentLine);
  return lines;
}

function wrapQualifier(text: string, key: string): string[] {
  if (QUALIFIER_INDENT.length + text.length <= LINE_WIDTH) return [`${QUALIFIER_INDENT}${text}`];
  const width = LINE_WIDTH - QUALIFIER_INDENT.length;
  const lines: string[] = [];
  if (UNSPACED_QUALIFIERS.has(key)) {
    // Hard-wrap sequence-like values; readers rejoin them without a separator.
    for (let i = 0; i < text.length; i += width) lines.push(QUALIFIER_INDENT + text.slice(i, i + width));
    return lines;
  }
  let line = "";
  for (const word of text.split(" ")) {
    if (line && line.length + 1 + word.length > width) {
      lines.push(QUALIFIER_INDENT + line);
      line = word;
    } else {
      line = line ? `${line} ${word}` : word;
    }
  }
  if (line) lines.push(QUALIFIER_INDENT + line);
  return lines;
}

function wrapField(key: string, value: string): string {
  const head = key.padEnd(12);
  const width = LINE_WIDTH - 12;
  const words = value.split(/\s+/);
  const lines: string[] = [];
  let line = "";
  for (const word of words) {
    if (line && line.length + 1 + word.length > width) { lines.push(line); line = word; }
    else line = line ? `${line} ${word}` : word;
  }
  if (line) lines.push(line);
  return lines.map((l, i) => (i === 0 ? head + l : " ".repeat(12) + l)).join("\n");
}

function writeOrigin(residues: string): string[] {
  const lines: string[] = [];
  const lower = residues.toLowerCase();
  for (let i = 0; i < lower.length; i += 60) {
    const chunk = lower.slice(i, i + 60);
    const groups: string[] = [];
    for (let j = 0; j < chunk.length; j += 10) groups.push(chunk.slice(j, j + 10));
    lines.push(`${String(i + 1).padStart(9)} ${groups.join(" ")}`);
  }
  return lines;
}

const MONTHS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];

function formatDate(date: Date): string {
  return `${String(date.getUTCDate()).padStart(2, "0")}-${MONTHS[date.getUTCMonth()]}-${date.getUTCFullYear()}`;
}
