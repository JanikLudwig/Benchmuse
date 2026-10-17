"use client";

import { useMemo, useRef, useState } from "react";
import {
  assignTracks,
  displayRange,
  featureColor,
  formatLength,
  pieces,
  rangeLength,
  type Overlay,
  type Selection,
  type SequenceFeature,
} from "./model";

interface Props {
  length: number;
  features: SequenceFeature[];
  overlays?: Overlay[];
  selection?: Selection | null;
  selectedFeatureId?: string | null;
  onSelectFeature?: (id: string | null) => void;
  onSelect?: (selection: Selection | null) => void;
  /** show only this window of the sequence */
  window?: { start: number; end: number };
  height?: number;
}

const WIDTH = 900;
const LEFT = 12;
const RIGHT = 12;
const AXIS_Y = 26;
const TRACK_HEIGHT = 15;

/** Linear map: an axis with feature bars stacked on tracks below it. */
export function LinearMap({
  length,
  features,
  overlays = [],
  selection,
  selectedFeatureId,
  onSelectFeature,
  onSelect,
  window: viewWindow,
  height,
}: Props) {
  const [hovered, setHovered] = useState<string | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const dragAnchor = useRef<number | null>(null);

  const from = viewWindow?.start ?? 0;
  const to = viewWindow?.end ?? length;
  const span = Math.max(1, to - from);

  const tracks = useMemo(() => assignTracks(features, length), [features, length]);
  const trackCount = Math.max(1, Math.max(0, ...tracks.values()) + 1);
  const svgHeight = height ?? AXIS_Y + 14 + trackCount * TRACK_HEIGHT + 14;
  const x = (position: number) => LEFT + ((position - from) / span) * (WIDTH - LEFT - RIGHT);
  const tickStep = useMemo(() => niceStep(span / 10), [span]);

  function positionAt(event: { clientX: number }): number | null {
    const svg = svgRef.current;
    if (!svg) return null;
    const rect = svg.getBoundingClientRect();
    const fraction = ((event.clientX - rect.left) / rect.width) * WIDTH;
    const position = from + ((fraction - LEFT) / (WIDTH - LEFT - RIGHT)) * span;
    return Math.max(0, Math.min(length, Math.round(position)));
  }

  return (
    <svg
      ref={svgRef}
      viewBox={`0 0 ${WIDTH} ${svgHeight}`}
      className="block w-full touch-none select-none"
      role="img"
      aria-label={`Linear map, ${formatLength(length)}`}
      onPointerDown={(e) => {
        if (!onSelect) return;
        const position = positionAt(e);
        if (position === null) return;
        dragAnchor.current = position;
        (e.target as Element).setPointerCapture?.(e.pointerId);
        onSelect({ start: position, end: position, strand: 1 });
      }}
      onPointerMove={(e) => {
        if (dragAnchor.current === null || !onSelect) return;
        const position = positionAt(e);
        if (position === null) return;
        const anchor = dragAnchor.current;
        onSelect({ start: Math.min(anchor, position), end: Math.max(anchor, position), strand: 1 });
      }}
      onPointerUp={() => {
        dragAnchor.current = null;
      }}
    >
      {selection && selection.end > selection.start && (
        <rect x={x(selection.start)} y={AXIS_Y - 14} width={Math.max(1, x(selection.end) - x(selection.start))} height={svgHeight - AXIS_Y + 6} fill="#6366f1" opacity={0.12} />
      )}

      <line x1={x(from)} x2={x(to)} y1={AXIS_Y} y2={AXIS_Y} stroke="#94a3b8" strokeWidth={2.5} />
      {ticksBetween(from, to, tickStep).map((position) => (
        <g key={position}>
          <line x1={x(position)} x2={x(position)} y1={AXIS_Y - 4} y2={AXIS_Y + 4} stroke="#94a3b8" />
          <text x={x(position)} y={AXIS_Y - 9} fontSize={9} fill="#64748b" textAnchor="middle">
            {position === 0 ? 1 : position.toLocaleString("en")}
          </text>
        </g>
      ))}

      {features.map((feature) => {
        const track = tracks.get(feature.id) ?? 0;
        const y = AXIS_Y + 12 + track * TRACK_HEIGHT;
        const active = hovered === feature.id || selectedFeatureId === feature.id;
        const dim = (hovered || selectedFeatureId) && !active;
        const color = featureColor(feature);
        const parts = feature.segments.flatMap((s) => pieces(s, length)).filter((p) => p.end > from && p.start < to);
        if (!parts.length) return null;

        return (
          <g
            key={feature.id}
            onMouseEnter={() => setHovered(feature.id)}
            onMouseLeave={() => setHovered(null)}
            onClick={(e) => {
              e.stopPropagation();
              onSelectFeature?.(selectedFeatureId === feature.id ? null : feature.id);
            }}
            className={onSelectFeature ? "cursor-pointer" : undefined}
            opacity={dim ? 0.35 : 1}
          >
            {/* A join is drawn as bars connected by a thin line, like an exon structure. */}
            {parts.length > 1 && (
              <line x1={x(parts[0]!.start)} x2={x(parts[parts.length - 1]!.end)} y1={y + 5.5} y2={y + 5.5} stroke={color} strokeWidth={1} strokeDasharray="3 2" />
            )}
            {parts.map((part, i) => {
              const barX = x(part.start);
              const barWidth = Math.max(2, x(part.end) - barX);
              const isTip = feature.strand === 1 ? i === parts.length - 1 : i === 0;
              return isTip && barWidth > 8 && feature.strand !== 0 ? (
                <polygon key={i} points={arrowPoints(barX, barWidth, y, feature.strand)} fill={color} />
              ) : (
                <rect key={i} x={barX} y={y} width={barWidth} height={11} rx={2} fill={color} />
              );
            })}
            {x(parts[parts.length - 1]!.end) - x(parts[0]!.start) > feature.name.length * 5.5 + 8 && (
              <text x={x(parts[0]!.start) + 4} y={y + 8.5} fontSize={8.5} fill="white" fontWeight={600} className="pointer-events-none">
                {feature.name}
              </text>
            )}
            <title>{`${feature.name} (${feature.type}) ${displayRange(feature.segments[0]!, length)}`}</title>
          </g>
        );
      })}

      {overlays.map((overlay) => {
        const point = rangeLength(overlay.range, length) <= 1;
        if (point) {
          return (
            <g key={overlay.id}>
              <line x1={x(overlay.range.start)} x2={x(overlay.range.start)} y1={AXIS_Y - 6} y2={AXIS_Y + 8} stroke={overlay.color} strokeWidth={1.6} />
              <text x={x(overlay.range.start)} y={AXIS_Y + 18} fontSize={8} fill={overlay.color} textAnchor="middle" fontWeight={600}>
                {overlay.label}
              </text>
              <title>{overlay.detail ?? overlay.label}</title>
            </g>
          );
        }
        return (
          <rect
            key={overlay.id}
            x={x(overlay.range.start)}
            y={AXIS_Y + 4}
            width={Math.max(2, x(overlay.range.end) - x(overlay.range.start))}
            height={4}
            fill={overlay.color}
            opacity={0.85}
          >
            <title>{overlay.detail ?? overlay.label}</title>
          </rect>
        );
      })}
    </svg>
  );
}

function arrowPoints(x: number, width: number, y: number, strand: 1 | -1 | 0): string {
  const tip = Math.min(7, width / 2);
  return strand === 1
    ? `${x},${y} ${x + width - tip},${y} ${x + width},${y + 5.5} ${x + width - tip},${y + 11} ${x},${y + 11}`
    : `${x + width},${y} ${x + tip},${y} ${x},${y + 5.5} ${x + tip},${y + 11} ${x + width},${y + 11}`;
}

function ticksBetween(from: number, to: number, step: number): number[] {
  const out: number[] = [];
  for (let position = Math.ceil(from / step) * step; position <= to; position += step) out.push(position);
  return out;
}

function niceStep(raw: number): number {
  if (raw <= 1) return 1;
  const power = 10 ** Math.floor(Math.log10(raw));
  const n = raw / power;
  return (n < 1.5 ? 1 : n < 3.5 ? 2 : n < 7.5 ? 5 : 10) * power;
}
