/**
 * Virtual agarose gel: where DNA fragments of a given size run, and which sizes a given gel can
 * actually separate.
 *
 * Migration through agarose is close to linear in log(size) across the resolving range, which is
 * the relationship these functions use. The resolving range itself depends on agarose
 * percentage; the limits below follow standard electrophoresis tables.
 */

export interface Ladder {
  name: string;
  /** fragment sizes in bp, largest first */
  sizes: number[];
  /** sizes drawn as brighter reference bands */
  referenceBands?: number[];
}

export const LADDERS: readonly Ladder[] = [
  {
    name: "1 kb DNA ladder",
    sizes: [10000, 8000, 6000, 5000, 4000, 3000, 2000, 1500, 1000, 500],
    referenceBands: [3000],
  },
  {
    name: "1 kb Plus DNA ladder",
    sizes: [10000, 8000, 6000, 5000, 4000, 3000, 2000, 1500, 1200, 1000, 900, 800, 700, 600, 500, 400, 300, 200, 100],
    referenceBands: [1500, 3000],
  },
  {
    name: "100 bp DNA ladder",
    sizes: [1517, 1200, 1000, 900, 800, 700, 600, 500, 400, 300, 200, 100],
    referenceBands: [500],
  },
  {
    name: "Lambda DNA/HindIII",
    sizes: [23130, 9416, 6557, 4361, 2322, 2027, 564, 125],
  },
];

export function getLadder(name: string): Ladder | undefined {
  return LADDERS.find((l) => l.name.toLowerCase() === name.toLowerCase());
}

export interface GelConditions {
  /** agarose percentage, w/v */
  agarose: number;
}

/** Size range an agarose gel separates well, from standard electrophoresis tables. */
export function resolvingRange(agarose: number): { min: number; max: number } {
  const table: [number, number, number][] = [
    [0.5, 1000, 30000],
    [0.75, 700, 12000],
    [1.0, 500, 10000],
    [1.25, 300, 7000],
    [1.5, 200, 4000],
    [2.0, 50, 2000],
    [3.0, 20, 1000],
  ];
  let closest = table[2]!;
  for (const row of table) {
    if (Math.abs(row[0] - agarose) < Math.abs(closest[0] - agarose)) closest = row;
  }
  return { min: closest[1], max: closest[2] };
}

/**
 * Relative migration of a fragment, 0 at the well and 1 at the dye front.
 *
 * Fragments above the resolving range pile up near the well and those below it run off the
 * bottom, so both are clamped — exactly what you see on a real gel.
 */
export function migration(sizeBp: number, conditions: GelConditions): number {
  const { min, max } = resolvingRange(conditions.agarose);
  if (sizeBp <= 0) return 1;
  const logMax = Math.log10(max);
  const logMin = Math.log10(min);
  const raw = (logMax - Math.log10(sizeBp)) / (logMax - logMin);
  // Leave a margin at each end so clamped bands remain visibly distinct from the extremes.
  return Math.max(0.02, Math.min(0.98, 0.05 + raw * 0.9));
}

export interface GelBand {
  sizeBp: number;
  /** 0 (well) to 1 (dye front) */
  position: number;
  /** relative brightness, proportional to mass of DNA in the band */
  intensity: number;
  /** several fragments of similar size that would run as one band */
  count: number;
  label: string;
}

export interface GelLane {
  name: string;
  bands: GelBand[];
  /** fragments too large or too small for this gel to resolve */
  unresolved: { tooLarge: number[]; tooSmall: number[] };
}

/**
 * Lay out one lane. Fragments within 5% of each other are merged, because a real gel cannot
 * separate them either.
 */
export function buildLane(name: string, fragmentSizes: readonly number[], conditions: GelConditions): GelLane {
  const { min, max } = resolvingRange(conditions.agarose);
  const sorted = [...fragmentSizes].filter((n) => n > 0).sort((a, b) => b - a);
  const merged: { size: number; count: number }[] = [];
  for (const size of sorted) {
    const last = merged[merged.length - 1];
    if (last && Math.abs(last.size - size) / last.size < 0.05) {
      last.count++;
    } else {
      merged.push({ size, count: 1 });
    }
  }

  // Staining intensity tracks the mass of DNA, which is size x copies.
  const maxMass = Math.max(1, ...merged.map((m) => m.size * m.count));
  const bands: GelBand[] = merged.map((m) => ({
    sizeBp: m.size,
    position: migration(m.size, conditions),
    intensity: Math.max(0.25, Math.sqrt((m.size * m.count) / maxMass)),
    count: m.count,
    label: m.count > 1 ? `${formatSize(m.size)} (x${m.count})` : formatSize(m.size),
  }));

  return {
    name,
    bands,
    unresolved: {
      tooLarge: sorted.filter((s) => s > max),
      tooSmall: sorted.filter((s) => s < min),
    },
  };
}

export function formatSize(bp: number): string {
  if (bp >= 1000) return `${(bp / 1000).toFixed(bp >= 10000 ? 0 : 1).replace(/\.0$/, "")} kb`;
  return `${bp} bp`;
}

/** Suggest the agarose percentage that best resolves a set of fragments. */
export function suggestAgarose(fragmentSizes: readonly number[]): number {
  const sizes = fragmentSizes.filter((n) => n > 0);
  if (!sizes.length) return 1;
  const smallest = Math.min(...sizes);
  if (smallest < 100) return 3;
  if (smallest < 300) return 2;
  if (smallest < 600) return 1.5;
  if (smallest < 1200) return 1.25;
  if (smallest < 3000) return 1;
  return 0.75;
}
