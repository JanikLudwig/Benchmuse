"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { Badge, Button, cx } from "../ui";
import { formatLength } from "../sequence/model";
import { ChromatogramTrace } from "./ChromatogramTrace";

export interface AlignedRead {
  id: string;
  name: string;
  strand: number;
  refStart: number | null;
  refEnd: number | null;
  identity: number | null;
  trimStart: number;
  trimEnd: number;
  trimmedLength: number;
  variantCount: number;
  failureReason: string | null;
  cigarString: string;
  fileId: string | null;
  sequence: string;
}

export interface AlignedVariant {
  type: "substitution" | "insertion" | "deletion";
  refStart: number;
  refBases: string;
  queryBases: string;
  label: string;
  quality?: number;
  effects: { featureName: string; consequence: string; proteinChange?: string; codonChange?: string; aaPosition?: number }[];
  readIds: string[];
  readNames: string[];
  supportingReads: number;
  coveringReads: number;
  confirmed: boolean;
}

export interface AlignmentData {
  alignment: { id: string; name: string; createdAt: string | Date };
  reference: { id: string; name: string; registryId: string | null; length: number; isCircular: boolean; sequence: string };
  reads: AlignedRead[];
  variants: AlignedVariant[];
  summary: {
    total: number;
    placed: number;
    failed: number;
    distinctVariants: number;
    confirmedVariants: number;
    consequences: Record<string, number>;
    coverage: number;
  };
}

const CONSEQUENCE_TONE: Record<string, "slate" | "green" | "amber" | "red" | "brand"> = {
  synonymous: "green",
  "non-coding": "slate",
  missense: "amber",
  "in-frame insertion": "amber",
  "in-frame deletion": "amber",
  nonsense: "red",
  frameshift: "red",
  "start lost": "red",
  "stop lost": "red",
};

export function AlignmentViewer({ data }: { data: AlignmentData }) {
  const [selectedVariant, setSelectedVariant] = useState<AlignedVariant | null>(data.variants[0] ?? null);
  const [openTrace, setOpenTrace] = useState<string | null>(null);

  const worstConsequence = (variant: AlignedVariant) =>
    variant.effects.reduce((worst, e) => (rank(e.consequence) > rank(worst) ? e.consequence : worst), "non-coding");

  return (
    <div className="space-y-6">
      <section className="grid grid-cols-2 gap-4 rounded-lg border border-slate-200 bg-white p-5 sm:grid-cols-5">
        <Stat label="Reads placed" value={`${data.summary.placed} of ${data.summary.total}`} tone={data.summary.failed ? "amber" : "green"} />
        <Stat label="Coverage" value={`${(data.summary.coverage * 100).toFixed(0)}%`} />
        <Stat label="Differences" value={String(data.summary.distinctVariants)} tone={data.summary.distinctVariants ? "amber" : "green"} />
        <Stat label="Confirmed" value={`${data.summary.confirmedVariants} of ${data.summary.distinctVariants}`} />
        <div>
          <dt className="text-xs text-slate-500">Reference</dt>
          <dd className="font-medium">
            <Link href={`/entities/${data.reference.id}`} className="hover:text-brand-600">
              {data.reference.name}
            </Link>
            <span className="ml-1.5 text-xs font-normal text-slate-500">{formatLength(data.reference.length)}</span>
          </dd>
        </div>
      </section>

      <section className="rounded-lg border border-slate-200 bg-white p-5">
        <h2 className="mb-3 font-semibold">Coverage</h2>
        <CoverageTrack data={data} selectedVariant={selectedVariant} onSelectVariant={setSelectedVariant} />
      </section>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-5">
        <section className="rounded-lg border border-slate-200 bg-white p-5 lg:col-span-3">
          <h2 className="mb-3 font-semibold">
            Differences from the reference
            {data.summary.distinctVariants === 0 && <span className="ml-2 text-sm font-normal text-emerald-700">none — the construct matches</span>}
          </h2>
          {data.variants.length > 0 && (
            <table className="w-full text-sm">
              <thead className="text-left text-xs uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="py-1 font-medium">Change</th>
                  <th className="py-1 font-medium">Effect</th>
                  <th className="py-1 font-medium">Protein</th>
                  <th className="py-1 font-medium">Reads</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {data.variants.map((variant, i) => {
                  const consequence = worstConsequence(variant);
                  return (
                    <tr
                      key={i}
                      onClick={() => setSelectedVariant(variant)}
                      className={cx("cursor-pointer", selectedVariant === variant ? "bg-brand-50" : "hover:bg-slate-50")}
                    >
                      <td className="py-1.5 font-mono text-xs">{variant.label}</td>
                      <td className="py-1.5">
                        <Badge tone={CONSEQUENCE_TONE[consequence] ?? "slate"}>{consequence}</Badge>
                        {variant.effects[0]?.featureName && (
                          <span className="ml-1.5 text-xs text-slate-500">in {variant.effects[0].featureName}</span>
                        )}
                      </td>
                      <td className="py-1.5 font-mono text-xs">{variant.effects[0]?.proteinChange ?? "—"}</td>
                      <td className="py-1.5">
                        <span className={cx("text-xs", variant.confirmed ? "text-slate-700" : "text-amber-700")}>
                          {variant.supportingReads} of {variant.coveringReads}
                          {!variant.confirmed && " (unconfirmed)"}
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
          {selectedVariant && (
            <VariantContext variant={selectedVariant} reference={data.reference} />
          )}
        </section>

        <section className="rounded-lg border border-slate-200 bg-white p-5 lg:col-span-2">
          <h2 className="mb-3 font-semibold">Reads</h2>
          <ul className="divide-y divide-slate-100">
            {data.reads.map((read) => (
              <li key={read.id} className="py-2">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="truncate font-medium">{read.name}</p>
                    {read.failureReason ? (
                      <p className="text-xs text-amber-700">{read.failureReason}</p>
                    ) : (
                      <p className="text-xs text-slate-500">
                        {read.refStart! + 1}–{read.refEnd} · {read.strand === 1 ? "forward" : "reverse"} · {read.identity}% identity
                        {read.variantCount > 0 && ` · ${read.variantCount} difference${read.variantCount === 1 ? "" : "s"}`}
                      </p>
                    )}
                    <p className="text-xs text-slate-400">
                      {read.sequence.length} bases read, {read.trimmedLength} kept after trimming
                    </p>
                  </div>
                  {read.fileId && (
                    <Button size="sm" variant="ghost" onClick={() => setOpenTrace(openTrace === read.id ? null : read.id)}>
                      {openTrace === read.id ? "Hide trace" : "Trace"}
                    </Button>
                  )}
                </div>
                {openTrace === read.id && <ChromatogramTrace readId={read.id} />}
              </li>
            ))}
          </ul>
        </section>
      </div>
    </div>
  );
}

function rank(consequence: string): number {
  const order = ["non-coding", "synonymous", "in-frame insertion", "in-frame deletion", "missense", "start lost", "stop lost", "frameshift", "nonsense"];
  return order.indexOf(consequence);
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: "green" | "amber" }) {
  return (
    <div>
      <dt className="text-xs text-slate-500">{label}</dt>
      <dd className={cx("font-semibold tabular-nums", tone === "green" && "text-emerald-700", tone === "amber" && "text-amber-700")}>{value}</dd>
    </div>
  );
}

/** Reference axis with one lane per read and a tick for every difference. */
function CoverageTrack({
  data,
  selectedVariant,
  onSelectVariant,
}: {
  data: AlignmentData;
  selectedVariant: AlignedVariant | null;
  onSelectVariant: (v: AlignedVariant) => void;
}) {
  const width = 900;
  const placed = data.reads.filter((r) => r.refStart !== null);
  const laneHeight = 14;
  const height = 34 + Math.max(1, placed.length) * laneHeight + 10;
  const x = (position: number) => 10 + (position / data.reference.length) * (width - 20);

  const ticks = useMemo(() => {
    const step = niceStep(data.reference.length / 10);
    const out: number[] = [];
    for (let p = 0; p < data.reference.length; p += step) out.push(p);
    return out;
  }, [data.reference.length]);

  return (
    <svg viewBox={`0 0 ${width} ${height}`} className="block w-full" role="img" aria-label="Read coverage across the reference">
      <line x1={x(0)} x2={x(data.reference.length)} y1={20} y2={20} stroke="#94a3b8" strokeWidth={2} />
      {ticks.map((p) => (
        <g key={p}>
          <line x1={x(p)} x2={x(p)} y1={16} y2={24} stroke="#94a3b8" />
          <text x={x(p)} y={11} fontSize={8.5} fill="#64748b" textAnchor="middle">
            {p === 0 ? 1 : p.toLocaleString("en")}
          </text>
        </g>
      ))}

      {placed.map((read, i) => {
        const y = 32 + i * laneHeight;
        const wraps = read.refEnd! < read.refStart!;
        const spans = wraps
          ? [
              { from: read.refStart!, to: data.reference.length },
              { from: 0, to: read.refEnd! },
            ]
          : [{ from: read.refStart!, to: read.refEnd! }];
        return (
          <g key={read.id}>
            {spans.map((span, j) => (
              <rect key={j} x={x(span.from)} y={y} width={Math.max(2, x(span.to) - x(span.from))} height={8} rx={2} fill={read.strand === 1 ? "#10b981" : "#0ea5e9"} opacity={0.75}>
                <title>{`${read.name}: ${read.refStart! + 1}–${read.refEnd} (${read.strand === 1 ? "forward" : "reverse"})`}</title>
              </rect>
            ))}
          </g>
        );
      })}

      {data.variants.map((variant, i) => (
        <g key={i} onClick={() => onSelectVariant(variant)} className="cursor-pointer">
          <line
            x1={x(variant.refStart)}
            x2={x(variant.refStart)}
            y1={16}
            y2={height - 10}
            stroke={selectedVariant === variant ? "#dc2626" : "#f87171"}
            strokeWidth={selectedVariant === variant ? 2 : 1.2}
          />
          <circle cx={x(variant.refStart)} cy={14} r={3.5} fill={selectedVariant === variant ? "#dc2626" : "#f87171"} />
          <title>{`${variant.label} — ${variant.effects[0]?.consequence ?? ""}`}</title>
        </g>
      ))}
    </svg>
  );
}

/** The reference bases around a difference, with the read's base shown beneath. */
function VariantContext({ variant, reference }: { variant: AlignedVariant; reference: { sequence: string; length: number } }) {
  const flank = 24;
  const from = Math.max(0, variant.refStart - flank);
  const to = Math.min(reference.length, variant.refStart + Math.max(1, variant.refBases.length) + flank);
  const before = reference.sequence.slice(from, variant.refStart);
  const at = reference.sequence.slice(variant.refStart, variant.refStart + Math.max(1, variant.refBases.length));
  const after = reference.sequence.slice(variant.refStart + Math.max(1, variant.refBases.length), to);

  return (
    <div className="mt-4 rounded-md bg-slate-50 p-3">
      <p className="mb-2 text-xs font-medium text-slate-600">
        {variant.label}
        {variant.effects[0]?.codonChange && <span className="ml-2 font-mono">{variant.effects[0].codonChange}</span>}
        {variant.quality !== undefined && <span className="ml-2 text-slate-500">base quality Q{variant.quality}</span>}
      </p>
      <pre className="overflow-x-auto font-mono text-xs leading-5">
        <div>
          <span className="text-slate-400">reference </span>
          {before}
          <span className="bg-red-100 font-bold text-red-700">{at}</span>
          {after}
        </div>
        <div>
          <span className="text-slate-400">read      </span>
          <span className="text-slate-400">{".".repeat(before.length)}</span>
          <span className="bg-emerald-100 font-bold text-emerald-700">
            {variant.type === "deletion" ? "-".repeat(at.length) : variant.queryBases || "-"}
          </span>
          <span className="text-slate-400">{".".repeat(after.length)}</span>
        </div>
      </pre>
      <p className="mt-2 text-xs text-slate-500">Seen in {variant.readNames.join(", ")}</p>
    </div>
  );
}

function niceStep(raw: number): number {
  if (raw <= 1) return 1;
  const power = 10 ** Math.floor(Math.log10(raw));
  const n = raw / power;
  return (n < 1.5 ? 1 : n < 3.5 ? 2 : n < 7.5 ? 5 : 10) * power;
}
