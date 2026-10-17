/**
 * ABIF (.ab1 / .fsa) chromatogram reader.
 *
 * ABIF is a big-endian tagged container: a header points at a directory of entries, each naming
 * a four-character tag, a type and either inline data (<= 4 bytes) or an offset. Everything here
 * is read-only and bounds-checked, because these files come from instruments and from users.
 */

import type { ParseResult, ParseWarning, SequenceRecord } from "./types";

const MAGIC = "ABIF";
const DIR_ENTRY_SIZE = 28;
const HEADER_DIR_OFFSET = 26;

type ElementType = number;
const TYPE_BYTE = 1;
const TYPE_CHAR = 2;
const TYPE_WORD = 3;
const TYPE_SHORT = 4;
const TYPE_LONG = 5;
const TYPE_FLOAT = 7;
const TYPE_DOUBLE = 8;
const TYPE_DATE = 10;
const TYPE_TIME = 11;
const TYPE_PSTRING = 18;
const TYPE_CSTRING = 19;

interface DirEntry {
  name: string;
  number: number;
  elementType: ElementType;
  elementSize: number;
  numElements: number;
  dataSize: number;
  dataOffset: number;
}

export interface Chromatogram {
  /** called bases, 5'->3' */
  sequence: string;
  /** phred quality per base, same length as `sequence` */
  qualities: number[];
  /** index into the trace arrays where each base was called */
  peakLocations: number[];
  /** processed trace intensities, keyed by base */
  traces: { A: number[]; C: number[]; G: number[]; T: number[] };
  sampleName?: string;
  runDate?: string;
  instrument?: string;
  dyeSet?: string;
  /** order the instrument stored the four channels in, e.g. "GATC" */
  baseOrder: string;
}

export function isAb1(bytes: Uint8Array): boolean {
  return bytes.length > 4 && String.fromCharCode(bytes[0]!, bytes[1]!, bytes[2]!, bytes[3]!) === MAGIC;
}

class Reader {
  readonly view: DataView;
  constructor(readonly bytes: Uint8Array) {
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }
  inBounds(offset: number, length: number): boolean {
    return offset >= 0 && length >= 0 && offset + length <= this.bytes.length;
  }
  ascii(offset: number, length: number): string {
    if (!this.inBounds(offset, length)) return "";
    let out = "";
    for (let i = 0; i < length; i++) out += String.fromCharCode(this.bytes[offset + i]!);
    return out;
  }
}

function readDirectory(r: Reader, warnings: ParseWarning[]): DirEntry[] {
  if (!r.inBounds(HEADER_DIR_OFFSET, DIR_ENTRY_SIZE)) {
    warnings.push({ message: "AB1 file is truncated: no directory header" });
    return [];
  }
  const root = readEntry(r, HEADER_DIR_OFFSET);
  const entries: DirEntry[] = [];
  for (let i = 0; i < root.numElements; i++) {
    const offset = root.dataOffset + i * DIR_ENTRY_SIZE;
    if (!r.inBounds(offset, DIR_ENTRY_SIZE)) {
      warnings.push({ message: `AB1 directory entry ${i} is out of bounds` });
      break;
    }
    entries.push(readEntry(r, offset));
  }
  return entries;
}

function readEntry(r: Reader, offset: number): DirEntry {
  return {
    name: r.ascii(offset, 4),
    number: r.view.getInt32(offset + 4, false),
    elementType: r.view.getInt16(offset + 8, false),
    elementSize: r.view.getInt16(offset + 10, false),
    numElements: r.view.getInt32(offset + 12, false),
    dataSize: r.view.getInt32(offset + 16, false),
    // Values of four bytes or fewer are stored in place of the offset.
    dataOffset: r.view.getInt32(offset + 20, false),
  };
}

function entryData(r: Reader, entry: DirEntry): number[] | string | null {
  // Values of four bytes or fewer are packed into the entry's own dataOffset field.
  if (entry.dataSize <= 4) {
    switch (entry.elementType) {
      case TYPE_CHAR:
      case TYPE_PSTRING:
      case TYPE_CSTRING:
        return inlineString(entry);
      case TYPE_BYTE:
      case TYPE_WORD:
      case TYPE_SHORT:
      case TYPE_LONG:
        return inlineNumbers(entry);
      default:
        return null;
    }
  }

  const base = entry.dataOffset;
  switch (entry.elementType) {
    case TYPE_CHAR:
    case TYPE_PSTRING:
    case TYPE_CSTRING: {
      let text = r.ascii(base, entry.dataSize);
      if (entry.elementType === TYPE_PSTRING) text = text.slice(1, 1 + (r.bytes[base] ?? 0));
      if (entry.elementType === TYPE_CSTRING) text = text.replace(/\0+$/, "");
      return text;
    }
    case TYPE_BYTE:
    case TYPE_WORD:
    case TYPE_SHORT:
    case TYPE_LONG:
    case TYPE_FLOAT:
    case TYPE_DOUBLE: {
      const out: number[] = [];
      for (let i = 0; i < entry.numElements; i++) {
        const at = base + i * entry.elementSize;
        if (!r.inBounds(at, entry.elementSize)) break;
        out.push(readNumber(r, at, entry.elementType));
      }
      return out;
    }
    case TYPE_DATE: {
      if (!r.inBounds(base, 4)) return null;
      const year = r.view.getInt16(base, false);
      return `${year}-${String(r.bytes[base + 2]!).padStart(2, "0")}-${String(r.bytes[base + 3]!).padStart(2, "0")}`;
    }
    case TYPE_TIME: {
      if (!r.inBounds(base, 4)) return null;
      return `${String(r.bytes[base]!).padStart(2, "0")}:${String(r.bytes[base + 1]!).padStart(2, "0")}:${String(r.bytes[base + 2]!).padStart(2, "0")}`;
    }
    default:
      return null;
  }
}

function readNumber(r: Reader, at: number, type: ElementType): number {
  switch (type) {
    case TYPE_BYTE: return r.view.getUint8(at);
    case TYPE_WORD: return r.view.getUint16(at, false);
    case TYPE_SHORT: return r.view.getInt16(at, false);
    case TYPE_LONG: return r.view.getInt32(at, false);
    case TYPE_FLOAT: return r.view.getFloat32(at, false);
    case TYPE_DOUBLE: return r.view.getFloat64(at, false);
    default: return 0;
  }
}

/** Inline values live in the four bytes of the entry's own dataOffset field. */
function inlineBytes(entry: DirEntry): number[] {
  const value = entry.dataOffset >>> 0;
  return [(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff].slice(0, entry.dataSize);
}

function inlineString(entry: DirEntry): string {
  return inlineBytes(entry)
    .map((b) => String.fromCharCode(b))
    .join("")
    .replace(/\0+$/, "");
}

function inlineNumbers(entry: DirEntry): number[] {
  const bytes = inlineBytes(entry);
  if (entry.elementType === TYPE_SHORT || entry.elementType === TYPE_WORD) {
    const out: number[] = [];
    for (let i = 0; i + 1 < bytes.length; i += 2) {
      const raw = (bytes[i]! << 8) | bytes[i + 1]!;
      out.push(entry.elementType === TYPE_SHORT && raw > 0x7fff ? raw - 0x10000 : raw);
    }
    return out;
  }
  if (entry.elementType === TYPE_LONG) return [((bytes[0]! << 24) | (bytes[1]! << 16) | (bytes[2]! << 8) | bytes[3]!) | 0];
  return bytes;
}

export function parseAb1(input: Uint8Array | ArrayBuffer): { chromatogram: Chromatogram | null; warnings: ParseWarning[] } {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  const warnings: ParseWarning[] = [];
  if (!isAb1(bytes)) {
    warnings.push({ message: "Not an ABIF file (missing ABIF signature)" });
    return { chromatogram: null, warnings };
  }
  const r = new Reader(bytes);
  const entries = readDirectory(r, warnings);
  const find = (name: string, number: number) => entries.find((e) => e.name === name && e.number === number);
  const get = (name: string, number: number) => {
    const entry = find(name, number);
    return entry ? entryData(r, entry) : null;
  };
  const asString = (v: unknown): string | undefined => (typeof v === "string" && v.length ? v : undefined);
  const asNumbers = (v: unknown): number[] => (Array.isArray(v) ? v : []);

  // Instruments write both the raw (.1) and the basecaller-corrected (.2) versions; prefer .2.
  const sequence = (asString(get("PBAS", 2)) ?? asString(get("PBAS", 1)) ?? "").replace(/[^A-Za-z]/g, "");
  if (!sequence) {
    warnings.push({ message: "AB1 file contains no base calls" });
    return { chromatogram: null, warnings };
  }
  const qualitiesRaw = get("PCON", 2) ?? get("PCON", 1);
  const qualities =
    typeof qualitiesRaw === "string" ? [...qualitiesRaw].map((ch) => ch.charCodeAt(0)) : asNumbers(qualitiesRaw);
  const peakLocations = asNumbers(get("PLOC", 2) ?? get("PLOC", 1));
  const baseOrder = (asString(get("FWO_", 1)) ?? "GATC").toUpperCase();

  // DATA.9-12 hold the processed traces, in the channel order given by FWO_.
  const channels = [9, 10, 11, 12].map((n) => asNumbers(get("DATA", n)));
  const traces: Chromatogram["traces"] = { A: [], C: [], G: [], T: [] };
  baseOrder.split("").forEach((base, i) => {
    if (base in traces) traces[base as keyof Chromatogram["traces"]] = channels[i] ?? [];
  });

  if (qualities.length && qualities.length !== sequence.length) {
    warnings.push({ message: "Quality values do not line up with base calls; they will be padded" });
  }
  const paddedQualities = Array.from({ length: sequence.length }, (_, i) => qualities[i] ?? 0);

  const runDate = asString(get("RUND", 1));
  const runTime = asString(get("RUNT", 1));

  return {
    chromatogram: {
      sequence: sequence.toUpperCase(),
      qualities: paddedQualities,
      peakLocations,
      traces,
      sampleName: asString(get("SMPL", 1)),
      runDate: runDate ? (runTime ? `${runDate} ${runTime}` : runDate) : undefined,
      instrument: asString(get("MCHN", 1)) ?? asString(get("MODL", 1)),
      dyeSet: asString(get("DySN", 1)),
      baseOrder,
    },
    warnings,
  };
}

/** Convert a parsed chromatogram into the record shape the rest of the app uses. */
export function chromatogramToRecord(chromatogram: Chromatogram, fallbackName: string): SequenceRecord {
  return {
    name: chromatogram.sampleName?.trim() || fallbackName,
    kind: "dna",
    isCircular: false,
    residues: chromatogram.sequence,
    features: [],
    format: "ab1",
    qualities: chromatogram.qualities,
    ...(chromatogram.runDate && { description: `Sequenced ${chromatogram.runDate}` }),
  };
}

export function parseAb1AsRecord(input: Uint8Array | ArrayBuffer, fallbackName: string): ParseResult {
  const { chromatogram, warnings } = parseAb1(input);
  return { records: chromatogram ? [chromatogramToRecord(chromatogram, fallbackName)] : [], warnings };
}

// ---------------------------------------------------------------------------------------------
// Quality trimming

export interface TrimResult {
  start: number;
  end: number;
  trimmedSequence: string;
  trimmedQualities: number[];
}

/**
 * Mott's trimming algorithm, as used by Phred and most assembly tools: find the window
 * maximising the sum of (cutoff - error probability), which clips the noisy ends of a read.
 */
export function trimByQuality(sequence: string, qualities: readonly number[], cutoffQuality = 20): TrimResult {
  const cutoff = Math.pow(10, -cutoffQuality / 10);
  let best = { score: 0, start: 0, end: 0 };
  let runningScore = 0;
  let runStart = 0;

  for (let i = 0; i < sequence.length; i++) {
    const q = qualities[i] ?? 0;
    const score = cutoff - Math.pow(10, -q / 10);
    if (runningScore + score <= 0) {
      runningScore = 0;
      runStart = i + 1;
      continue;
    }
    runningScore += score;
    if (runningScore > best.score) best = { score: runningScore, start: runStart, end: i + 1 };
  }
  if (best.end <= best.start) return { start: 0, end: 0, trimmedSequence: "", trimmedQualities: [] };
  return {
    start: best.start,
    end: best.end,
    trimmedSequence: sequence.slice(best.start, best.end),
    trimmedQualities: qualities.slice(best.start, best.end) as number[],
  };
}

/** Mean quality, the number sequencing providers report per read. */
export function meanQuality(qualities: readonly number[]): number {
  if (!qualities.length) return 0;
  return qualities.reduce((a, b) => a + b, 0) / qualities.length;
}
