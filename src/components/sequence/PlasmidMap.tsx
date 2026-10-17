"use client";

import { useMemo, useRef, useState } from "react";
import {
  assignTracks,
  contains,
  displayRange,
  featureColor,
  featureLength,
  formatLength,
  pieces,
  rangeLength,
  wraps,
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
  title?: string;
}

const SIZE = 420;
const CENTER = SIZE / 2;
const BACKBONE_RADIUS = 132;
const TRACK_WIDTH = 13;

/** Circular plasmid map with feature arcs, tick marks and a selection wedge. */
export function PlasmidMap({
  length,
  features,
  overlays = [],
  selection,
  selectedFeatureId,
  onSelectFeature,
  onSelect,
  title,
}: Props) {
  const [hovered, setHovered] = useState<string | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const dragAnchor = useRef<number | null>(null);

  const tracks = useMemo(() => assignTracks(features, length), [features, length]);
  const trackCount = Math.max(0, ...tracks.values()) + 1;
  const tickStep = useMemo(() => niceStep(length / 10), [length]);

  const angle = (position: number) => (position / length) * 2 * Math.PI - Math.PI / 2;
  const point = (position: number, radius: number) =>
    [CENTER + radius * Math.cos(angle(position)), CENTER + radius * Math.sin(angle(position))] as const;

  /** Which base a pointer position corresponds to. */
  function positionAt(event: { clientX: number; clientY: number }): number | null {
    const svg = svgRef.current;
    if (!svg) return null;
    const rect = svg.getBoundingClientRect();
    const x = ((event.clientX - rect.left) / rect.width) * SIZE - CENTER;
    const y = ((event.clientY - rect.top) / rect.height) * SIZE - CENTER;
    const theta = Math.atan2(y, x) + Math.PI / 2;
    const fraction = ((theta / (2 * Math.PI)) % 1 + 1) % 1;
    return Math.round(fraction * length) % length;
  }

  return (
    <figure className="m-0">
      <svg
        ref={svgRef}
        viewBox={`0 0 ${SIZE} ${SIZE}`}
        className="mx-auto block w-full max-w-md touch-none select-none"
        role="img"
        aria-label={`Circular map, ${formatLength(length)}`}
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
          // Dragging anticlockwise past the origin selects the wrapping arc.
          onSelect(position >= anchor ? { start: anchor, end: position, strand: 1 } : { start: position, end: anchor, strand: 1 });
        }}
        onPointerUp={() => {
          dragAnchor.current = null;
        }}
      >
        {/* Selection wedge, drawn under everything else. */}
        {selection && selection.end !== selection.start && (
          <path
            d={wedgePath(selection.start, selection.end, BACKBONE_RADIUS + trackCount * TRACK_WIDTH + 10, point, length)}
            fill="#6366f1"
            opacity={0.14}
          />
        )}

        <circle cx={CENTER} cy={CENTER} r={BACKBONE_RADIUS} fill="none" stroke="#cbd5e1" strokeWidth={2.5} />

        {ticks(length, tickStep).map((position) => {
          const [x1, y1] = point(position, BACKBONE_RADIUS - 5);
          const [x2, y2] = point(position, BACKBONE_RADIUS + 5);
          const [tx, ty] = point(position, BACKBONE_RADIUS - 17);
          return (
            <g key={position}>
              <line x1={x1} y1={y1} x2={x2} y2={y2} stroke="#94a3b8" strokeWidth={1} />
              <text x={tx} y={ty} fontSize={8.5} fill="#64748b" textAnchor="middle" dominantBaseline="middle">
                {position === 0 ? "1" : position.toLocaleString("en")}
              </text>
            </g>
          );
        })}

        {features.map((feature) => {
          const track = tracks.get(feature.id) ?? 0;
          const radius = BACKBONE_RADIUS + 12 + track * TRACK_WIDTH;
          const active = hovered === feature.id || selectedFeatureId === feature.id;
          const dim = (hovered || selectedFeatureId) && !active;
          const color = featureColor(feature);
          const span = featureLength(feature, length);
          const mid = midpoint(feature.segments[0]!.start, span, length);
          const [lx, ly] = point(mid, radius + 15);
          const showLabel = active || span > length / 18;

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
            >
              {feature.segments.flatMap((segment, i) =>
                pieces(segment, length).map((piece, j) => (
                  <path
                    key={`${i}-${j}`}
                    d={arcPath(piece.start, piece.end, radius, point, length)}
                    fill="none"
                    stroke={color}
                    strokeWidth={active ? 10 : 7.5}
                    opacity={dim ? 0.3 : 1}
                    strokeLinecap="butt"
                  />
                )),
              )}
              {/* Direction marker at the feature's 3' end. */}
              {feature.strand !== 0 && span > length / 60 && (
                <polygon
                  points={arrowHead(feature.strand === 1 ? endOf(feature, length) : feature.segments[0]!.start, radius, feature.strand, point, length)}
                  fill={color}
                  opacity={dim ? 0.3 : 1}
                />
              )}
              {showLabel && (
                <text
                  x={lx}
                  y={ly}
                  fontSize={9.5}
                  fill="#334155"
                  fontWeight={active ? 700 : 500}
                  textAnchor={lx < CENTER - 6 ? "end" : lx > CENTER + 6 ? "start" : "middle"}
                  dominantBaseline="middle"
                  opacity={dim ? 0.4 : 1}
                  className="pointer-events-none"
                >
                  {feature.name}
                </text>
              )}
              <title>{`${feature.name} (${feature.type}) ${displayRange(feature.segments[0]!, length)}${feature.strand === -1 ? " reverse" : ""}`}</title>
            </g>
          );
        })}

        {/* Cut sites and other point overlays sit just inside the backbone. */}
        {overlays.map((overlay) => {
          const isPoint = rangeLength(overlay.range, length) <= 1;
          if (isPoint) {
            const [x1, y1] = point(overlay.range.start, BACKBONE_RADIUS - 12);
            const [x2, y2] = point(overlay.range.start, BACKBONE_RADIUS + 12);
            const [tx, ty] = point(overlay.range.start, BACKBONE_RADIUS - 24);
            return (
              <g key={overlay.id}>
                <line x1={x1} y1={y1} x2={x2} y2={y2} stroke={overlay.color} strokeWidth={1.6} />
                <text x={tx} y={ty} fontSize={8.5} fill={overlay.color} textAnchor="middle" dominantBaseline="middle" fontWeight={600}>
                  {overlay.label}
                </text>
                <title>{overlay.detail ?? overlay.label}</title>
              </g>
            );
          }
          return (
            <path
              key={overlay.id}
              d={arcPath(overlay.range.start, overlay.range.end, BACKBONE_RADIUS - 8, point, length)}
              fill="none"
              stroke={overlay.color}
              strokeWidth={4}
              opacity={0.85}
            >
              <title>{overlay.detail ?? overlay.label}</title>
            </path>
          );
        })}

        <text x={CENTER} y={CENTER - 8} textAnchor="middle" fontSize={14} fontWeight={600} fill="#1e293b">
          {title ?? formatLength(length)}
        </text>
        <text x={CENTER} y={CENTER + 11} textAnchor="middle" fontSize={10.5} fill="#64748b">
          {title ? formatLength(length) : "circular"}
        </text>
        {selection && selection.end !== selection.start && (
          <text x={CENTER} y={CENTER + 28} textAnchor="middle" fontSize={9.5} fill="#4f46e5">
            {selection.start + 1}–{selection.end} ({formatLength(selection.end - selection.start)})
          </text>
        )}
      </svg>
    </figure>
  );
}

type PointFn = (position: number, radius: number) => readonly [number, number];

function arcPath(start: number, end: number, radius: number, point: PointFn, length: number): string {
  const span = end > start ? end - start : length - start + end;
  const [x1, y1] = point(start, radius);
  // A full circle cannot be one arc; stop fractionally short.
  const [x2, y2] = point(span >= length ? start + length - length / 720 : end, radius);
  return `M ${x1} ${y1} A ${radius} ${radius} 0 ${span > length / 2 ? 1 : 0} 1 ${x2} ${y2}`;
}

function wedgePath(start: number, end: number, radius: number, point: PointFn, length: number): string {
  const span = end > start ? end - start : length - start + end;
  const [x1, y1] = point(start, radius);
  const [x2, y2] = point(end, radius);
  return `M ${CENTER} ${CENTER} L ${x1} ${y1} A ${radius} ${radius} 0 ${span > length / 2 ? 1 : 0} 1 ${x2} ${y2} Z`;
}

function arrowHead(position: number, radius: number, strand: 1 | -1 | 0, point: PointFn, length: number): string {
  const tipOffset = (strand === 1 ? 1 : -1) * (length / 180);
  const [tx, ty] = point(position + tipOffset, radius);
  const [ax, ay] = point(position, radius - 6);
  const [bx, by] = point(position, radius + 6);
  return `${tx},${ty} ${ax},${ay} ${bx},${by}`;
}

function endOf(feature: SequenceFeature, length: number): number {
  const last = feature.segments[feature.segments.length - 1]!;
  return last.end % Math.max(length, 1);
}

function midpoint(start: number, span: number, length: number): number {
  return (start + span / 2) % length;
}

function ticks(length: number, step: number): number[] {
  const out: number[] = [];
  for (let position = 0; position < length; position += step) out.push(position);
  return out;
}

function niceStep(raw: number): number {
  if (raw <= 1) return 1;
  const power = 10 ** Math.floor(Math.log10(raw));
  const n = raw / power;
  return (n < 1.5 ? 1 : n < 3.5 ? 2 : n < 7.5 ? 5 : 10) * power;
}
