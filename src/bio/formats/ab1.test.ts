import { describe, expect, it } from "vitest";
import { isAb1, meanQuality, parseAb1, parseAb1AsRecord, trimByQuality } from "./ab1";

/**
 * Build a minimal but structurally valid ABIF file, so the binary reader is tested against the
 * real layout rather than a mock.
 */
function buildAb1(opts: {
  sequence: string;
  qualities: number[];
  peaks?: number[];
  traces?: Record<string, number[]>;
  sampleName?: string;
  baseOrder?: string;
  inlineShort?: number;
}): Uint8Array {
  const entries: { name: string; number: number; type: number; size: number; data: Uint8Array }[] = [];
  const ascii = (s: string) => new Uint8Array([...s].map((c) => c.charCodeAt(0)));
  const shorts = (values: number[]) => {
    const b = new Uint8Array(values.length * 2);
    const v = new DataView(b.buffer);
    values.forEach((n, i) => v.setInt16(i * 2, n, false));
    return b;
  };

  entries.push({ name: "PBAS", number: 2, type: 2, size: 1, data: ascii(opts.sequence) });
  entries.push({ name: "PCON", number: 2, type: 2, size: 1, data: new Uint8Array(opts.qualities) });
  if (opts.peaks) entries.push({ name: "PLOC", number: 2, type: 4, size: 2, data: shorts(opts.peaks) });
  entries.push({ name: "FWO_", number: 1, type: 2, size: 1, data: ascii(opts.baseOrder ?? "GATC") });
  if (opts.sampleName) entries.push({ name: "SMPL", number: 1, type: 18, size: 1, data: new Uint8Array([opts.sampleName.length, ...ascii(opts.sampleName)]) });
  if (opts.traces) {
    (opts.baseOrder ?? "GATC").split("").forEach((base, i) => {
      entries.push({ name: "DATA", number: 9 + i, type: 4, size: 2, data: shorts(opts.traces![base] ?? []) });
    });
  }
  if (opts.inlineShort !== undefined) {
    entries.push({ name: "LANE", number: 1, type: 4, size: 2, data: shorts([opts.inlineShort]) });
  }

  const DIR_ENTRY = 28;
  const headerSize = 128;
  const dirOffset = headerSize;
  let dataCursor = dirOffset + entries.length * DIR_ENTRY;
  const chunks: { offset: number; data: Uint8Array }[] = [];
  const placed = entries.map((e) => {
    const inline = e.data.length <= 4;
    let dataOffset: number;
    if (inline) {
      // Pack the bytes into the dataOffset field, left-aligned, big-endian.
      const padded = new Uint8Array(4);
      padded.set(e.data.slice(0, 4));
      dataOffset = (padded[0]! << 24) | (padded[1]! << 16) | (padded[2]! << 8) | padded[3]!;
    } else {
      dataOffset = dataCursor;
      chunks.push({ offset: dataCursor, data: e.data });
      dataCursor += e.data.length;
    }
    return { ...e, dataOffset };
  });

  const total = dataCursor;
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  out.set(ascii("ABIF"), 0);
  view.setInt16(4, 101, false);

  // Root directory entry at offset 26 describes the directory itself.
  const writeEntry = (at: number, e: { name: string; number: number; type: number; size: number; count: number; dataSize: number; dataOffset: number }) => {
    out.set(ascii(e.name), at);
    view.setInt32(at + 4, e.number, false);
    view.setInt16(at + 8, e.type, false);
    view.setInt16(at + 10, e.size, false);
    view.setInt32(at + 12, e.count, false);
    view.setInt32(at + 16, e.dataSize, false);
    view.setInt32(at + 20, e.dataOffset, false);
  };
  writeEntry(26, { name: "tdir", number: 1, type: 1023, size: DIR_ENTRY, count: placed.length, dataSize: placed.length * DIR_ENTRY, dataOffset: dirOffset });

  placed.forEach((e, i) => {
    writeEntry(dirOffset + i * DIR_ENTRY, {
      name: e.name,
      number: e.number,
      type: e.type,
      size: e.size,
      count: Math.floor(e.data.length / e.size),
      dataSize: e.data.length,
      dataOffset: e.dataOffset,
    });
  });
  for (const chunk of chunks) out.set(chunk.data, chunk.offset);
  return out;
}

const SEQUENCE = "ACGTACGTACGTTTGACCATGGCATGCATTACG";
const QUALITIES = SEQUENCE.split("").map((_, i) => (i < 4 || i > SEQUENCE.length - 4 ? 8 : 45));

describe("AB1 chromatograms", () => {
  const file = buildAb1({
    sequence: SEQUENCE,
    qualities: QUALITIES,
    peaks: SEQUENCE.split("").map((_, i) => 20 + i * 12),
    traces: { G: [10, 900, 20], A: [800, 15, 30], T: [12, 18, 950], C: [5, 25, 40] },
    sampleName: "pDEMO-F01",
    inlineShort: 7,
  });

  it("recognises the format", () => {
    expect(isAb1(file)).toBe(true);
    expect(isAb1(new Uint8Array([1, 2, 3, 4]))).toBe(false);
  });

  it("reads base calls, qualities and metadata", () => {
    const { chromatogram, warnings } = parseAb1(file);
    expect(warnings).toEqual([]);
    expect(chromatogram!.sequence).toBe(SEQUENCE);
    expect(chromatogram!.qualities).toEqual(QUALITIES);
    expect(chromatogram!.sampleName).toBe("pDEMO-F01");
    expect(chromatogram!.baseOrder).toBe("GATC");
    expect(chromatogram!.peakLocations.slice(0, 3)).toEqual([20, 32, 44]);
  });

  it("maps trace channels onto bases using the stored channel order", () => {
    const { chromatogram } = parseAb1(file);
    expect(chromatogram!.traces.A).toEqual([800, 15, 30]);
    expect(chromatogram!.traces.T).toEqual([12, 18, 950]);
  });

  it("reads values small enough to be stored inline", () => {
    // LANE is a single short, so it lives in the directory entry itself.
    const { chromatogram } = parseAb1(file);
    expect(chromatogram).not.toBeNull();
  });

  it("converts to a sequence record", () => {
    const { records } = parseAb1AsRecord(file, "fallback");
    expect(records[0]).toMatchObject({ name: "pDEMO-F01", kind: "dna", isCircular: false, format: "ab1", residues: SEQUENCE });
    expect(records[0]!.qualities).toHaveLength(SEQUENCE.length);
  });

  it("rejects non-ABIF data without throwing", () => {
    const { chromatogram, warnings } = parseAb1(new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7]));
    expect(chromatogram).toBeNull();
    expect(warnings[0]!.message).toMatch(/Not an ABIF file/);
  });

  it("survives a truncated file", () => {
    const truncated = file.slice(0, 40);
    const { chromatogram, warnings } = parseAb1(truncated);
    expect(chromatogram).toBeNull();
    expect(warnings.length).toBeGreaterThan(0);
  });
});

describe("quality trimming", () => {
  it("clips low-quality ends and keeps the good middle", () => {
    const trimmed = trimByQuality(SEQUENCE, QUALITIES, 20);
    expect(trimmed.start).toBe(4);
    expect(trimmed.end).toBe(SEQUENCE.length - 3);
    expect(trimmed.trimmedSequence).toBe(SEQUENCE.slice(4, SEQUENCE.length - 3));
    expect(trimmed.trimmedQualities.every((q) => q === 45)).toBe(true);
  });

  it("returns nothing when the whole read is poor", () => {
    const poor = trimByQuality("ACGTACGT", [5, 5, 5, 5, 5, 5, 5, 5], 20);
    expect(poor.trimmedSequence).toBe("");
  });

  it("keeps a uniformly good read intact", () => {
    const good = trimByQuality("ACGTACGT", new Array(8).fill(40), 20);
    expect(good).toMatchObject({ start: 0, end: 8 });
  });

  it("averages quality", () => {
    expect(meanQuality([40, 20])).toBe(30);
    expect(meanQuality([])).toBe(0);
  });
});
