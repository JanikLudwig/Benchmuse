"use client";

import { useEffect, useState } from "react";
import { api, errorMessage } from "@/lib/api";
import { ErrorText } from "../ui";

interface Chromatogram {
  sequence: string;
  qualities: number[];
  peakLocations: number[];
  traces: { A: number[]; C: number[]; G: number[]; T: number[] };
  sampleName?: string;
}

const BASE_COLORS: Record<string, string> = { A: "#16a34a", C: "#2563eb", G: "#1e293b", T: "#dc2626" };
const WINDOW_BASES = 40;

/** Chromatogram peaks around a position, as a sequencing facility's viewer would show them. */
export function ChromatogramTrace({ readId, centerBase = 0 }: { readId: string; centerBase?: number }) {
  const [data, setData] = useState<Chromatogram | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [offset, setOffset] = useState(centerBase);

  useEffect(() => {
    let cancelled = false;
    api<{ chromatogram: Chromatogram | null }>("GET", `/reads/${readId}/chromatogram`)
      .then((res) => {
        if (cancelled) return;
        setData(res.chromatogram);
      })
      .catch((e) => !cancelled && setError(errorMessage(e)))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [readId]);

  if (loading) return <p className="mt-2 text-xs text-slate-500">Loading trace…</p>;
  if (error) return <ErrorText>{error}</ErrorText>;
  if (!data) return <p className="mt-2 text-xs text-slate-500">This read has no chromatogram (it was supplied as plain sequence).</p>;
  if (!data.peakLocations.length) return <p className="mt-2 text-xs text-slate-500">This chromatogram has no peak data.</p>;

  const first = Math.max(0, Math.min(offset, data.sequence.length - WINDOW_BASES));
  const last = Math.min(data.sequence.length, first + WINDOW_BASES);
  const startSample = data.peakLocations[first] ?? 0;
  const endSample = data.peakLocations[last - 1] ?? startSample + 1;
  const sampleSpan = Math.max(1, endSample - startSample);

  const width = 900;
  const height = 120;
  const maxIntensity = Math.max(
    1,
    ...(["A", "C", "G", "T"] as const).flatMap((base) => data.traces[base].slice(startSample, endSample)),
  );
  const x = (sample: number) => ((sample - startSample) / sampleSpan) * (width - 20) + 10;
  const y = (intensity: number) => height - 28 - (intensity / maxIntensity) * (height - 44);

  return (
    <div className="mt-2">
      <div className="mb-1 flex items-center gap-2 text-xs">
        <button onClick={() => setOffset(Math.max(0, first - WINDOW_BASES))} className="rounded border border-slate-300 px-1.5 py-0.5 hover:bg-slate-50">
          ←
        </button>
        <span className="text-slate-500">
          bases {first + 1}–{last} of {data.sequence.length}
        </span>
        <button
          onClick={() => setOffset(Math.min(data.sequence.length - WINDOW_BASES, first + WINDOW_BASES))}
          className="rounded border border-slate-300 px-1.5 py-0.5 hover:bg-slate-50"
        >
          →
        </button>
      </div>
      <svg viewBox={`0 0 ${width} ${height}`} className="block w-full rounded border border-slate-200 bg-white" role="img" aria-label="Chromatogram trace">
        {(["A", "C", "G", "T"] as const).map((base) => {
          const points = data.traces[base]
            .slice(startSample, endSample)
            .map((intensity, i) => `${x(startSample + i)},${y(intensity)}`)
            .join(" ");
          return <polyline key={base} points={points} fill="none" stroke={BASE_COLORS[base]} strokeWidth={1.1} opacity={0.85} />;
        })}
        {Array.from({ length: last - first }, (_, i) => {
          const index = first + i;
          const sample = data.peakLocations[index];
          if (sample === undefined) return null;
          const base = data.sequence[index] ?? "N";
          const quality = data.qualities[index] ?? 0;
          return (
            <g key={index}>
              <text x={x(sample)} y={height - 14} fontSize={10} fill={BASE_COLORS[base] ?? "#64748b"} textAnchor="middle" fontFamily="ui-monospace, monospace">
                {base}
              </text>
              {/* Quality bar: short and pale means a doubtful call. */}
              <rect x={x(sample) - 3} y={height - 10} width={6} height={Math.max(1, (quality / 60) * 8)} fill="#94a3b8" opacity={quality < 20 ? 0.4 : 0.8} />
            </g>
          );
        })}
      </svg>
    </div>
  );
}
