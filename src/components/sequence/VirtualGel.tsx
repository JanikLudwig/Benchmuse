"use client";

import { formatSize, type GelLane } from "@/bio/gel";

interface Props {
  lanes: GelLane[];
  agarose: number;
  /** highlight bands of these sizes, e.g. the fragment you want to cut out */
  highlight?: number[];
}

const LANE_WIDTH = 86;
const GEL_TOP = 26;
const GEL_HEIGHT = 300;

/** A simulated agarose gel. Band positions come from the migration model in src/bio/gel. */
export function VirtualGel({ lanes, agarose, highlight = [] }: Props) {
  const width = Math.max(220, lanes.length * LANE_WIDTH + 40);
  const height = GEL_TOP + GEL_HEIGHT + 30;

  return (
    <figure className="m-0">
      <svg viewBox={`0 0 ${width} ${height}`} className="block w-full max-w-xl" role="img" aria-label={`Simulated ${agarose}% agarose gel`}>
        <rect x={0} y={GEL_TOP - 14} width={width} height={GEL_HEIGHT + 28} rx={4} fill="#0f172a" />

        {lanes.map((lane, laneIndex) => {
          const x = 24 + laneIndex * LANE_WIDTH;
          return (
            <g key={lane.name}>
              {/* The well */}
              <rect x={x} y={GEL_TOP - 10} width={LANE_WIDTH - 18} height={6} rx={1} fill="#1e293b" stroke="#334155" />
              <text x={x + (LANE_WIDTH - 18) / 2} y={GEL_TOP - 16} fontSize={9} fill="#94a3b8" textAnchor="middle">
                {lane.name.length > 14 ? `${lane.name.slice(0, 13)}…` : lane.name}
              </text>

              {lane.bands.map((band) => {
                const y = GEL_TOP + band.position * GEL_HEIGHT;
                const isHighlighted = highlight.some((h) => Math.abs(h - band.sizeBp) / band.sizeBp < 0.02);
                return (
                  <g key={`${lane.name}-${band.sizeBp}`}>
                    <rect
                      x={x}
                      y={y}
                      width={LANE_WIDTH - 18}
                      height={Math.max(2.5, 4 * band.intensity)}
                      rx={1}
                      fill={isHighlighted ? "#fbbf24" : "#e2e8f0"}
                      opacity={0.35 + band.intensity * 0.65}
                    />
                    <text x={x + LANE_WIDTH - 15} y={y + 5} fontSize={8} fill={isHighlighted ? "#fbbf24" : "#64748b"}>
                      {band.label}
                    </text>
                    <title>{`${band.label} at ${(band.position * 100).toFixed(0)}% migration`}</title>
                  </g>
                );
              })}
            </g>
          );
        })}

        <text x={width - 8} y={height - 8} fontSize={9} fill="#64748b" textAnchor="end">
          {agarose}% agarose
        </text>
      </svg>

      {lanes.some((l) => l.unresolved.tooLarge.length || l.unresolved.tooSmall.length) && (
        <figcaption className="mt-2 text-xs text-amber-700">
          {lanes.flatMap((lane) => [
            ...(lane.unresolved.tooLarge.length
              ? [`${lane.name}: ${lane.unresolved.tooLarge.map(formatSize).join(", ")} run too high to resolve on this gel.`]
              : []),
            ...(lane.unresolved.tooSmall.length
              ? [`${lane.name}: ${lane.unresolved.tooSmall.map(formatSize).join(", ")} run off the bottom.`]
              : []),
          ]).join(" ")}
        </figcaption>
      )}
    </figure>
  );
}
