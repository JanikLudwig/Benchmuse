"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { cx } from "../ui";
import {
  contains,
  featureColor,
  pieces,
  type Overlay,
  type Selection,
  type SequenceFeature,
} from "./model";

interface Props {
  sequence: string;
  features: SequenceFeature[];
  overlays?: Overlay[];
  selection?: Selection | null;
  onSelect?: (selection: Selection | null) => void;
  selectedFeatureId?: string | null;
  onSelectFeature?: (id: string | null) => void;
  /** show the complementary strand under the top strand */
  showComplement?: boolean;
  /** show the three-frame translation of a selected CDS */
  translateFeatureId?: string | null;
  kind: "dna" | "aa";
  /** scroll so this position is visible */
  scrollTo?: number | null;
}

const GROUP = 10;
const ROW_HEIGHT_PX = 20;
/** Width of one character in the monospace stack at 12.5px, measured once below. */
const DEFAULT_CHAR_PX = 7.52;
const GUTTER_CHARS = 18;

/**
 * The base-by-base view.
 *
 * Only the rows near the viewport are rendered, so a 100 kb sequence stays responsive; the
 * spacer divs above and below keep the scrollbar honest.
 */
export function SequenceText({
  sequence,
  features,
  overlays = [],
  selection,
  onSelect,
  selectedFeatureId,
  onSelectFeature,
  showComplement = false,
  kind,
  scrollTo,
}: Props) {
  const length = sequence.length;
  const containerRef = useRef<HTMLDivElement>(null);
  const measureRef = useRef<HTMLSpanElement>(null);
  const [basesPerRow, setBasesPerRow] = useState(60);
  const dragAnchor = useRef<number | null>(null);

  // Fit as many whole groups of ten as the panel is wide, so nothing is clipped at any size.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const fit = () => {
      const charPx = (measureRef.current?.getBoundingClientRect().width ?? DEFAULT_CHAR_PX * 10) / 10 || DEFAULT_CHAR_PX;
      const usable = el.clientWidth - 24 - GUTTER_CHARS * charPx;
      // Each group of ten costs eleven characters once the separating space is counted.
      const groups = Math.max(1, Math.floor(usable / (charPx * (GROUP + 1))));
      setBasesPerRow(Math.min(120, groups * GROUP));
    };
    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const rowCount = Math.max(1, Math.ceil(length / basesPerRow));
  const [visible, setVisible] = useState({ first: 0, last: 40 });

  const rowsPerFeature = useMemo(() => {
    // Index features by row so each row only looks at what it needs to draw.
    const index = new Map<number, SequenceFeature[]>();
    for (const feature of features) {
      for (const segment of feature.segments) {
        for (const piece of pieces(segment, length)) {
          const firstRow = Math.floor(piece.start / basesPerRow);
          const lastRow = Math.floor(Math.max(piece.start, piece.end - 1) / basesPerRow);
          for (let row = firstRow; row <= lastRow; row++) {
            const list = index.get(row) ?? [];
            if (!list.includes(feature)) list.push(feature);
            index.set(row, list);
          }
        }
      }
    }
    return index;
  }, [features, length, basesPerRow]);

  const overlaysByRow = useMemo(() => {
    const index = new Map<number, Overlay[]>();
    for (const overlay of overlays) {
      for (const piece of pieces(overlay.range, length)) {
        const firstRow = Math.floor(piece.start / basesPerRow);
        const lastRow = Math.floor(Math.max(piece.start, piece.end - 1) / basesPerRow);
        for (let row = firstRow; row <= lastRow; row++) {
          const list = index.get(row) ?? [];
          if (!list.includes(overlay)) list.push(overlay);
          index.set(row, list);
        }
      }
    }
    return index;
  }, [overlays, length, basesPerRow]);

  const recomputeVisible = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    const approxRowHeight = el.scrollHeight / rowCount || ROW_HEIGHT_PX;
    const first = Math.max(0, Math.floor(el.scrollTop / approxRowHeight) - 5);
    const last = Math.min(rowCount, first + Math.ceil(el.clientHeight / approxRowHeight) + 10);
    setVisible({ first, last });
  }, [rowCount]);

  useEffect(() => {
    recomputeVisible();
  }, [recomputeVisible, sequence, basesPerRow]);

  useEffect(() => {
    if (scrollTo === null || scrollTo === undefined) return;
    const el = containerRef.current;
    if (!el) return;
    const row = Math.floor(scrollTo / basesPerRow);
    const approxRowHeight = el.scrollHeight / rowCount || ROW_HEIGHT_PX;
    el.scrollTop = Math.max(0, row * approxRowHeight - el.clientHeight / 3);
  }, [scrollTo, rowCount, basesPerRow]);

  function positionFromEvent(event: React.PointerEvent): number | null {
    const target = (event.target as HTMLElement).closest("[data-base-index]");
    if (!target) return null;
    const index = Number(target.getAttribute("data-base-index"));
    return Number.isFinite(index) ? index : null;
  }

  const rows = [];
  for (let row = visible.first; row < visible.last; row++) {
    const start = row * basesPerRow;
    const end = Math.min(start + basesPerRow, length);
    const chunk = sequence.slice(start, end);
    rows.push(
      <Row
        key={row}
        start={start}
        chunk={chunk}
        features={rowsPerFeature.get(row) ?? []}
        overlays={overlaysByRow.get(row) ?? []}
        selection={selection}
        selectedFeatureId={selectedFeatureId}
        onSelectFeature={onSelectFeature}
        showComplement={showComplement && kind === "dna"}
        length={length}
      />,
    );
  }

  return (
    <div
      ref={containerRef}
      onScroll={recomputeVisible}
      onPointerDown={(e) => {
        if (!onSelect) return;
        const position = positionFromEvent(e);
        if (position === null) return;
        dragAnchor.current = position;
        onSelect({ start: position, end: position + 1, strand: 1 });
      }}
      onPointerMove={(e) => {
        if (dragAnchor.current === null || !onSelect) return;
        const position = positionFromEvent(e);
        if (position === null) return;
        const anchor = dragAnchor.current;
        onSelect({ start: Math.min(anchor, position), end: Math.max(anchor, position) + 1, strand: 1 });
      }}
      onPointerUp={() => {
        dragAnchor.current = null;
      }}
      className="max-h-[60vh] overflow-y-auto overflow-x-hidden rounded-md border border-slate-200 bg-white p-3 font-mono text-[12.5px] leading-[1.35]"
    >
      {/* Hidden ruler used to measure the real character width of the monospace font. */}
      <span ref={measureRef} aria-hidden className="pointer-events-none absolute -z-10 select-none opacity-0">
        ACGTACGTAC
      </span>
      <div style={{ height: visible.first * ROW_HEIGHT_PX * (showComplement ? 2.2 : 1.8) }} aria-hidden />
      {rows}
      <div style={{ height: Math.max(0, (rowCount - visible.last) * ROW_HEIGHT_PX * (showComplement ? 2.2 : 1.8)) }} aria-hidden />
    </div>
  );
}

interface RowProps {
  start: number;
  chunk: string;
  features: SequenceFeature[];
  overlays: Overlay[];
  selection?: Selection | null;
  selectedFeatureId?: string | null;
  onSelectFeature?: (id: string | null) => void;
  showComplement: boolean;
  length: number;
}

const COMPLEMENT: Record<string, string> = { A: "T", T: "A", G: "C", C: "G", U: "A", N: "N" };

function Row({ start, chunk, features, overlays, selection, selectedFeatureId, onSelectFeature, showComplement, length }: RowProps) {
  const selected = (index: number) => !!selection && index >= selection.start && index < selection.end;

  return (
    <div className="mb-1 flex gap-3">
      <span className="w-14 shrink-0 select-none pt-[1px] text-right text-slate-400 tabular-nums">{start + 1}</span>
      <div className="min-w-0 flex-1">
        <div className="whitespace-pre">
          {[...chunk].map((base, i) => {
            const index = start + i;
            return (
              <span
                key={i}
                data-base-index={index}
                className={cx(
                  "inline-block",
                  selected(index) && "bg-brand-200",
                  overlays.some((o) => contains(o.range, index, length)) && !selected(index) && "underline decoration-2 underline-offset-2",
                )}
                style={overlayStyle(overlays, index, length)}
              >
                {base}
                {(i + 1) % GROUP === 0 && i !== chunk.length - 1 ? " " : ""}
              </span>
            );
          })}
        </div>
        {showComplement && (
          <div className="whitespace-pre text-slate-400">
            {[...chunk].map((base, i) => (
              <span key={i} className="inline-block">
                {COMPLEMENT[base.toUpperCase()] ?? base}
                {(i + 1) % GROUP === 0 && i !== chunk.length - 1 ? " " : ""}
              </span>
            ))}
          </div>
        )}
        {features.map((feature) => {
          const bars = feature.segments
            .flatMap((s) => pieces(s, length))
            .filter((p) => p.start < start + chunk.length && p.end > start);
          if (!bars.length) return null;
          const active = selectedFeatureId === feature.id;
          return (
            <div key={feature.id} className="relative h-[7px]">
              {bars.map((bar, i) => {
                const from = Math.max(bar.start, start) - start;
                const to = Math.min(bar.end, start + chunk.length) - start;
                return (
                  <button
                    key={i}
                    type="button"
                    title={`${feature.name} (${feature.type})`}
                    onClick={(e) => {
                      e.stopPropagation();
                      onSelectFeature?.(active ? null : feature.id);
                    }}
                    className={cx("absolute top-0 h-[5px] rounded-sm", active && "ring-1 ring-slate-900")}
                    style={{
                      left: `${charOffset(from)}ch`,
                      width: `${Math.max(0.5, charOffset(to) - charOffset(from) - (to % GROUP === 0 && to > from ? 1 : 0))}ch`,
                      background: featureColor(feature),
                    }}
                  >
                    <span className="sr-only">{feature.name}</span>
                  </button>
                );
              })}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** Column of a base once a space is inserted every ten residues. */
const charOffset = (index: number) => index + Math.floor(index / GROUP);

function overlayStyle(overlays: Overlay[], index: number, length: number): React.CSSProperties | undefined {
  const hit = overlays.find((o) => contains(o.range, index, length));
  return hit ? { textDecorationColor: hit.color } : undefined;
}
