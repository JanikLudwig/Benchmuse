"use client";

import { useCallback, useEffect, useState } from "react";
import { api, errorMessage } from "@/lib/api";
import { formatSize, type GelLane } from "@/bio/gel";
import { Badge, Button, ErrorText, Input, Label, Select, cx } from "../ui";
import { formatLength, OVERLAY_COLORS, type Overlay, type Selection, type SequenceFeature } from "./model";
import { VirtualGel } from "./VirtualGel";

export type ToolId = "digest" | "primers" | "crispr" | "orfs" | "find" | "translate" | "properties" | "annotate";

const TOOLS: { id: ToolId; label: string; dnaOnly?: boolean }[] = [
  { id: "digest", label: "Digest", dnaOnly: true },
  { id: "primers", label: "Primers", dnaOnly: true },
  { id: "crispr", label: "CRISPR", dnaOnly: true },
  { id: "orfs", label: "ORFs", dnaOnly: true },
  { id: "find", label: "Find" },
  { id: "translate", label: "Translate", dnaOnly: true },
  { id: "properties", label: "Properties" },
  { id: "annotate", label: "Annotate" },
];

interface Props {
  entityId: string;
  length: number;
  isCircular: boolean;
  kind: "dna" | "aa";
  selection: Selection | null;
  onOverlays: (overlays: Overlay[]) => void;
  onGoTo: (position: number) => void;
  onFeaturesChanged: () => void;
  readOnly?: boolean;
}

export function ToolsPanel(props: Props) {
  const [tool, setTool] = useState<ToolId>(props.kind === "aa" ? "properties" : "digest");
  const available = TOOLS.filter((t) => props.kind === "dna" || !t.dnaOnly);

  // Overlays belong to one tool at a time, so switching clears the previous tool's marks.
  useEffect(() => {
    props.onOverlays([]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tool]);

  return (
    <section className="rounded-lg border border-slate-200 bg-white">
      <div className="flex flex-wrap gap-0.5 border-b border-slate-200 px-2 pt-2" role="tablist" aria-label="Sequence tools">
        {available.map((t) => (
          <button
            key={t.id}
            role="tab"
            aria-selected={tool === t.id}
            onClick={() => setTool(t.id)}
            className={cx(
              "rounded-t-md px-3 py-1.5 text-sm font-medium",
              tool === t.id ? "bg-white text-brand-700 shadow-[inset_0_-2px_0_0_var(--color-brand-600)]" : "text-slate-500 hover:text-slate-800",
            )}
          >
            {t.label}
          </button>
        ))}
      </div>
      <div className="p-4">
        {tool === "digest" && <DigestTool {...props} />}
        {tool === "primers" && <PrimerTool {...props} />}
        {tool === "crispr" && <CrisprTool {...props} />}
        {tool === "orfs" && <OrfTool {...props} />}
        {tool === "find" && <FindTool {...props} />}
        {tool === "translate" && <TranslateTool {...props} />}
        {tool === "properties" && <PropertiesTool {...props} />}
        {tool === "annotate" && <AnnotateTool {...props} />}
      </div>
    </section>
  );
}

/** Shared request state for a tool: loading, error and result. */
function useTool<T>(entityId: string) {
  const [result, setResult] = useState<T | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const run = useCallback(
    async (body: Record<string, unknown>) => {
      setBusy(true);
      setError("");
      try {
        setResult(await api<T>("POST", `/entities/${entityId}/tools`, body));
      } catch (e) {
        setError(errorMessage(e));
        setResult(null);
      } finally {
        setBusy(false);
      }
    },
    [entityId],
  );

  return { result, error, busy, run, setResult };
}

// ---------------------------------------------------------------------------------------------

interface DigestResult {
  sites: { enzyme: string; topCut: number; overhang: string; overhangType: string; isTypeIIS: boolean }[];
  summary: { enzyme: string; site: string; cuts: number; positions: number[]; overhangType: string; isTypeIIS: boolean }[];
  fragments: { index: number; length: number; leftEnd: { enzyme: string | null }; rightEnd: { enzyme: string | null } }[];
  gel: { agarose: number; lanes: GelLane[] };
  nonCutters: string[];
}

function DigestTool({ entityId, onOverlays, onGoTo }: Props) {
  const { result, error, busy, run } = useTool<DigestResult>(entityId);
  const [chosen, setChosen] = useState<string[]>([]);
  const [showAll, setShowAll] = useState(false);

  useEffect(() => {
    run({ tool: "digest", allEnzymes: showAll });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showAll]);

  useEffect(() => {
    if (!result) return;
    const active = chosen.length ? result.sites.filter((s) => chosen.includes(s.enzyme)) : [];
    onOverlays(
      active.map((site, i) => ({
        id: `cut-${site.enzyme}-${i}`,
        kind: "cut" as const,
        label: site.enzyme,
        range: { start: site.topCut, end: site.topCut + 1 },
        color: OVERLAY_COLORS.cut,
        detail: `${site.enzyme} cuts at ${site.topCut + 1}${site.overhang ? `, ${site.overhangType}' overhang ${site.overhang}` : ", blunt"}`,
      })),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [result, chosen]);

  const toggle = (enzyme: string) =>
    setChosen((current) => (current.includes(enzyme) ? current.filter((e) => e !== enzyme) : [...current, enzyme]));

  const singleCutters = result?.summary.filter((s) => s.cuts === 1) ?? [];
  const others = result?.summary.filter((s) => s.cuts > 1) ?? [];
  const selectedFragments = chosen.length ? result?.fragments : undefined;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-slate-600">Select enzymes to mark their sites and simulate the gel.</p>
        <label className="flex items-center gap-1.5 text-xs text-slate-600">
          <input type="checkbox" checked={showAll} onChange={(e) => setShowAll(e.target.checked)} /> all enzymes
        </label>
      </div>
      <ErrorText>{error}</ErrorText>
      {busy && <p className="text-sm text-slate-500">Scanning…</p>}

      {result && (
        <>
          <div>
            <h4 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-slate-500">Cuts once</h4>
            <div className="flex flex-wrap gap-1.5">
              {singleCutters.map((s) => (
                <EnzymeChip key={s.enzyme} summary={s} active={chosen.includes(s.enzyme)} onClick={() => toggle(s.enzyme)} onGoTo={onGoTo} />
              ))}
              {!singleCutters.length && <span className="text-sm text-slate-500">None</span>}
            </div>
          </div>

          {others.length > 0 && (
            <details>
              <summary className="cursor-pointer text-xs font-semibold uppercase tracking-wide text-slate-500">
                Cuts more than once ({others.length})
              </summary>
              <div className="mt-2 flex flex-wrap gap-1.5">
                {others.map((s) => (
                  <EnzymeChip key={s.enzyme} summary={s} active={chosen.includes(s.enzyme)} onClick={() => toggle(s.enzyme)} onGoTo={onGoTo} />
                ))}
              </div>
            </details>
          )}

          <div>
            <h4 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-slate-500">
              Does not cut ({result.nonCutters.length})
            </h4>
            <p className="font-mono text-xs text-slate-500">
              {result.nonCutters.slice(0, 40).join(", ")}
              {result.nonCutters.length > 40 ? ` and ${result.nonCutters.length - 40} more` : ""}
            </p>
          </div>

          {chosen.length > 0 && (
            <DigestResultView entityId={entityId} enzymes={chosen} />
          )}
          {!chosen.length && selectedFragments === undefined && (
            <p className="text-sm text-slate-500">Pick one or more enzymes above to see the fragments and gel.</p>
          )}
        </>
      )}
    </div>
  );
}

function EnzymeChip({
  summary,
  active,
  onClick,
  onGoTo,
}: {
  summary: { enzyme: string; site: string; cuts: number; positions: number[]; isTypeIIS: boolean };
  active: boolean;
  onClick: () => void;
  onGoTo: (position: number) => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      onDoubleClick={() => summary.positions[0] !== undefined && onGoTo(summary.positions[0])}
      title={`${summary.site}${summary.isTypeIIS ? " (Type IIS)" : ""} — cuts at ${summary.positions.map((p) => p + 1).join(", ")}`}
      className={cx(
        "rounded-full border px-2.5 py-1 text-xs font-medium",
        active ? "border-brand-500 bg-brand-50 text-brand-700" : "border-slate-300 bg-white text-slate-700 hover:border-slate-400",
      )}
    >
      {summary.enzyme}
      {summary.cuts > 1 && <span className="ml-1 text-slate-500">×{summary.cuts}</span>}
    </button>
  );
}

/** Fragments and gel for the chosen enzymes. */
function DigestResultView({ entityId, enzymes }: { entityId: string; enzymes: string[] }) {
  const { result, error, busy, run } = useTool<DigestResult>(entityId);
  useEffect(() => {
    run({ tool: "digest", enzymes });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enzymes.join(",")]);

  if (busy) return <p className="text-sm text-slate-500">Digesting…</p>;
  if (error) return <ErrorText>{error}</ErrorText>;
  if (!result) return null;

  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
      <div>
        <h4 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-slate-500">
          Fragments ({result.fragments.length})
        </h4>
        <table className="w-full text-sm">
          <thead className="text-left text-xs text-slate-500">
            <tr>
              <th className="py-1 font-medium">Size</th>
              <th className="py-1 font-medium">Left end</th>
              <th className="py-1 font-medium">Right end</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {[...result.fragments]
              .sort((a, b) => b.length - a.length)
              .map((f) => (
                <tr key={f.index}>
                  <td className="py-1 font-medium tabular-nums">{formatSize(f.length)}</td>
                  <td className="py-1 text-slate-600">{f.leftEnd.enzyme ?? "—"}</td>
                  <td className="py-1 text-slate-600">{f.rightEnd.enzyme ?? "—"}</td>
                </tr>
              ))}
          </tbody>
        </table>
      </div>
      <VirtualGel lanes={result.gel.lanes} agarose={result.gel.agarose} />
    </div>
  );
}

// ---------------------------------------------------------------------------------------------

interface PrimerPairResult {
  pairs: {
    forward: { sequence: string; oligo: string; tm: number; gc: number; range: { start: number; end: number }; warnings: string[] };
    reverse: { sequence: string; oligo: string; tm: number; gc: number; range: { start: number; end: number }; warnings: string[] };
    productLength: number;
    annealingTemp: number;
    tmDifference: number;
    warnings: string[];
  }[];
  warnings: string[];
}

function PrimerTool({ entityId, selection, length, onOverlays }: Props) {
  const { result, error, busy, run } = useTool<PrimerPairResult>(entityId);
  const [tm, setTm] = useState(60);
  const [forwardTail, setForwardTail] = useState("");
  const [reverseTail, setReverseTail] = useState("");

  const target = selection && selection.end > selection.start ? selection : null;

  return (
    <div className="space-y-4">
      <p className="text-sm text-slate-600">
        {target
          ? `Design primers to amplify ${target.start + 1}–${target.end} (${formatLength(target.end - target.start)}).`
          : "Select a region on the map or sequence to amplify."}
      </p>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <label>
          <Label>Target Tm (°C)</Label>
          <Input type="number" min={45} max={75} value={tm} onChange={(e) => setTm(Number(e.target.value))} />
        </label>
        <label className="sm:col-span-1">
          <Label hint="optional">Forward tail</Label>
          <Input value={forwardTail} onChange={(e) => setForwardTail(e.target.value)} placeholder="GAATTC" className="font-mono" />
        </label>
        <label>
          <Label hint="optional">Reverse tail</Label>
          <Input value={reverseTail} onChange={(e) => setReverseTail(e.target.value)} placeholder="AAGCTT" className="font-mono" />
        </label>
        <div className="flex items-end">
          <Button
            variant="primary"
            disabled={!target || busy}
            onClick={() => target && run({ tool: "design-primers", target: { start: target.start, end: target.end }, targetTm: tm, forwardTail, reverseTail })}
          >
            Design primers
          </Button>
        </div>
      </div>

      <ErrorText>{error}</ErrorText>
      {result?.warnings.map((w) => (
        <p key={w} className="text-sm text-amber-700">{w}</p>
      ))}

      {result?.pairs.map((pair, i) => (
        <div
          key={i}
          className="rounded-md border border-slate-200 p-3"
          onMouseEnter={() =>
            onOverlays([
              { id: "fwd", kind: "primer", label: "F", range: pair.forward.range, color: OVERLAY_COLORS.primer, detail: `Forward primer, Tm ${pair.forward.tm.toFixed(1)} °C` },
              { id: "rev", kind: "primer", label: "R", range: pair.reverse.range, color: OVERLAY_COLORS.primer, detail: `Reverse primer, Tm ${pair.reverse.tm.toFixed(1)} °C` },
            ])
          }
        >
          <div className="mb-2 flex items-center justify-between">
            <span className="text-sm font-semibold">Pair {i + 1}</span>
            <span className="text-xs text-slate-500">
              product {formatLength(pair.productLength)} · anneal {pair.annealingTemp} °C · ΔTm {pair.tmDifference.toFixed(1)} °C
            </span>
          </div>
          {(["forward", "reverse"] as const).map((direction) => {
            const primer = pair[direction];
            return (
              <div key={direction} className="mb-1.5 grid grid-cols-[3rem_1fr_auto] items-center gap-2 text-sm">
                <span className="text-xs font-medium uppercase text-slate-500">{direction === "forward" ? "Fwd" : "Rev"}</span>
                <code className="truncate font-mono text-xs">{primer.oligo}</code>
                <span className="whitespace-nowrap text-xs text-slate-500">
                  {primer.oligo.length} nt · {primer.tm.toFixed(1)} °C · {(primer.gc * 100).toFixed(0)}% GC
                </span>
              </div>
            );
          })}
          {pair.warnings.map((w) => (
            <p key={w} className="mt-1 text-xs text-amber-700">{w}</p>
          ))}
        </div>
      ))}
      {result && !result.pairs.length && <p className="text-sm text-slate-500">No pair met the criteria.</p>}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------

interface GuideResult {
  enzyme: string;
  guides: {
    spacer: string;
    pam: string;
    range: { start: number; end: number };
    strand: 1 | -1;
    cutSite: number;
    gc: number;
    onTargetScore: number;
    specificityScore: number;
    offTargetCount: number;
    warnings: string[];
    cloningOligos: { top: string; bottom: string; note: string };
  }[];
}

function CrisprTool({ entityId, selection, onOverlays, onGoTo }: Props) {
  const { result, error, busy, run } = useTool<GuideResult>(entityId);
  const [enzyme, setEnzyme] = useState("SpCas9");
  const target = selection && selection.end > selection.start ? selection : null;

  useEffect(() => {
    if (!result) return;
    onOverlays(
      result.guides.slice(0, 12).map((g, i) => ({
        id: `guide-${i}`,
        kind: "guide" as const,
        label: `g${i + 1}`,
        range: g.range,
        strand: g.strand,
        color: OVERLAY_COLORS.guide,
        detail: `${g.spacer} ${g.pam} — on-target ${g.onTargetScore}, specificity ${g.specificityScore}`,
      })),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [result]);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-3">
        <label>
          <Label>Nuclease</Label>
          <Select value={enzyme} onChange={(e) => setEnzyme(e.target.value)}>
            {["SpCas9", "SpCas9-NG", "SaCas9", "Cas12a (Cpf1)", "Cas9-VQR"].map((n) => (
              <option key={n}>{n}</option>
            ))}
          </Select>
        </label>
        <Button
          variant="primary"
          disabled={busy}
          onClick={() => run({ tool: "guides", enzyme, ...(target ? { target: { start: target.start, end: target.end } } : {}), limit: 30 })}
        >
          Find guides{target ? " in selection" : ""}
        </Button>
        <span className="text-xs text-slate-500">
          {target ? `Searching ${target.start + 1}–${target.end}` : "Select a region first to narrow the search"}
        </span>
      </div>

      <ErrorText>{error}</ErrorText>
      {busy && <p className="text-sm text-slate-500">Scoring guides…</p>}

      {result && (
        <table className="w-full text-sm">
          <thead className="text-left text-xs uppercase tracking-wide text-slate-500">
            <tr>
              <th className="py-1 font-medium">Spacer</th>
              <th className="py-1 font-medium">PAM</th>
              <th className="py-1 font-medium">Cut</th>
              <th className="py-1 font-medium">On-target</th>
              <th className="py-1 font-medium">Specificity</th>
              <th className="py-1 font-medium">Off-targets</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {result.guides.map((g, i) => (
              <tr key={i} className="cursor-pointer hover:bg-slate-50" onClick={() => onGoTo(g.cutSite)}>
                <td className="py-1.5 font-mono text-xs">
                  {g.spacer}
                  {g.warnings.length > 0 && (
                    <span title={g.warnings.join("; ")} className="ml-1 text-amber-600">
                      ⚠
                    </span>
                  )}
                </td>
                <td className="py-1.5 font-mono text-xs text-slate-500">{g.pam}</td>
                <td className="py-1.5 tabular-nums">{g.cutSite + 1}{g.strand === -1 ? " ←" : ""}</td>
                <td className="py-1.5"><Score value={g.onTargetScore} /></td>
                <td className="py-1.5"><Score value={g.specificityScore} /></td>
                <td className="py-1.5 text-slate-600">{g.offTargetCount}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {result && !result.guides.length && <p className="text-sm text-slate-500">No guides found in that region.</p>}
    </div>
  );
}

function Score({ value }: { value: number }) {
  const tone = value >= 70 ? "bg-emerald-500" : value >= 40 ? "bg-amber-500" : "bg-red-500";
  return (
    <span className="flex items-center gap-1.5">
      <span className="h-1.5 w-12 overflow-hidden rounded-full bg-slate-200">
        <span className={cx("block h-full rounded-full", tone)} style={{ width: `${value}%` }} />
      </span>
      <span className="tabular-nums text-xs text-slate-600">{value}</span>
    </span>
  );
}

// ---------------------------------------------------------------------------------------------

function OrfTool({ entityId, onOverlays, onGoTo }: Props) {
  const { result, error, busy, run } = useTool<{ orfs: { range: { start: number; end: number }; strand: 1 | -1; aaLength: number; protein: string }[] }>(entityId);
  const [minAa, setMinAa] = useState(50);

  useEffect(() => {
    run({ tool: "orfs", minAaLength: minAa });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!result) return;
    onOverlays(
      result.orfs.slice(0, 20).map((o, i) => ({
        id: `orf-${i}`,
        kind: "match" as const,
        label: `${o.aaLength} aa`,
        range: o.range,
        strand: o.strand,
        color: OVERLAY_COLORS.match,
        detail: `${o.aaLength} aa open reading frame`,
      })),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [result]);

  return (
    <div className="space-y-3">
      <div className="flex items-end gap-3">
        <label>
          <Label>Minimum length (aa)</Label>
          <Input type="number" min={10} max={2000} value={minAa} onChange={(e) => setMinAa(Number(e.target.value))} className="w-32" />
        </label>
        <Button disabled={busy} onClick={() => run({ tool: "orfs", minAaLength: minAa })}>
          Find ORFs
        </Button>
      </div>
      <ErrorText>{error}</ErrorText>
      {result && (
        <table className="w-full text-sm">
          <thead className="text-left text-xs uppercase tracking-wide text-slate-500">
            <tr>
              <th className="py-1 font-medium">Position</th>
              <th className="py-1 font-medium">Strand</th>
              <th className="py-1 font-medium">Length</th>
              <th className="py-1 font-medium">Protein</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {result.orfs.map((o, i) => (
              <tr key={i} className="cursor-pointer hover:bg-slate-50" onClick={() => onGoTo(o.range.start)}>
                <td className="py-1.5 tabular-nums">{o.range.start + 1}–{o.range.end}</td>
                <td className="py-1.5">{o.strand === 1 ? "→" : "←"}</td>
                <td className="py-1.5 tabular-nums">{o.aaLength} aa</td>
                <td className="py-1.5 truncate font-mono text-xs text-slate-600">{o.protein.slice(0, 40)}…</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {result && !result.orfs.length && <p className="text-sm text-slate-500">No ORFs of that length.</p>}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------

function FindTool({ entityId, onOverlays, onGoTo }: Props) {
  const { result, error, busy, run } = useTool<{ pattern: string; total: number; matches: { range: { start: number; end: number }; strand: 1 | -1; mismatches: number }[] }>(entityId);
  const [pattern, setPattern] = useState("");
  const [mismatches, setMismatches] = useState(0);

  useEffect(() => {
    if (!result) return;
    onOverlays(
      result.matches.slice(0, 200).map((m, i) => ({
        id: `match-${i}`,
        kind: "match" as const,
        label: "",
        range: m.range,
        strand: m.strand,
        color: OVERLAY_COLORS.match,
        detail: `${result.pattern}${m.mismatches ? ` (${m.mismatches} mismatch)` : ""}`,
      })),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [result]);

  return (
    <div className="space-y-3">
      <form
        action={() => run({ tool: "find", pattern, maxMismatches: mismatches, bothStrands: true })}
        className="flex flex-wrap items-end gap-3"
      >
        <label className="min-w-64 flex-1">
          <Label hint="IUPAC codes allowed, e.g. GGNNCC">Search for</Label>
          <Input value={pattern} onChange={(e) => setPattern(e.target.value)} placeholder="GAATTC" className="font-mono" />
        </label>
        <label>
          <Label>Mismatches</Label>
          <Select value={String(mismatches)} onChange={(e) => setMismatches(Number(e.target.value))} className="w-24">
            {[0, 1, 2, 3].map((n) => (
              <option key={n}>{n}</option>
            ))}
          </Select>
        </label>
        <Button type="submit" variant="primary" disabled={busy || pattern.trim().length < 3}>
          Find
        </Button>
      </form>
      <ErrorText>{error}</ErrorText>
      {result && (
        <>
          <p className="text-sm text-slate-600">
            {result.total} match{result.total === 1 ? "" : "es"} for <code className="font-mono">{result.pattern}</code>
          </p>
          <div className="flex flex-wrap gap-1.5">
            {result.matches.slice(0, 60).map((m, i) => (
              <button
                key={i}
                onClick={() => onGoTo(m.range.start)}
                className="rounded border border-slate-300 px-2 py-0.5 font-mono text-xs hover:border-brand-500 hover:text-brand-700"
              >
                {m.range.start + 1}
                {m.strand === -1 ? " ←" : ""}
                {m.mismatches > 0 ? ` (${m.mismatches})` : ""}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------

function TranslateTool({ entityId, selection }: Props) {
  const { result, error, busy, run } = useTool<{ protein: string; proteinToStop: string; length: number; gc: number; tm: number | null }>(entityId);
  const [strand, setStrand] = useState<1 | -1>(1);
  const target = selection && selection.end > selection.start ? selection : null;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-end gap-3">
        <label>
          <Label>Strand</Label>
          <Select value={String(strand)} onChange={(e) => setStrand(Number(e.target.value) as 1 | -1)} className="w-36">
            <option value="1">Forward</option>
            <option value="-1">Reverse</option>
          </Select>
        </label>
        <Button
          variant="primary"
          disabled={!target || busy}
          onClick={() => target && run({ tool: "translate", range: { start: target.start, end: target.end }, strand })}
        >
          Translate selection
        </Button>
        {!target && <span className="text-sm text-slate-500">Select a region first.</span>}
      </div>
      <ErrorText>{error}</ErrorText>
      {result && (
        <div className="space-y-2">
          <p className="text-xs text-slate-500">
            {result.length} bp · {(result.gc * 100).toFixed(1)}% GC{result.tm !== null ? ` · Tm ${result.tm.toFixed(1)} °C` : ""} ·{" "}
            {result.proteinToStop.length} aa to the first stop
          </p>
          <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-all rounded-md bg-slate-50 p-3 font-mono text-xs">{result.protein}</pre>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------

function PropertiesTool({ entityId, selection, length, kind }: Props) {
  const { result, error, busy, run } = useTool<{ length: number; counts: Record<string, number>; gc: number | null; tm: number | null; molecularWeight: number }>(entityId);
  const target = selection && selection.end > selection.start ? selection : null;

  useEffect(() => {
    run({ tool: "properties", ...(target ? { range: { start: target.start, end: target.end } } : {}) });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target?.start, target?.end]);

  return (
    <div className="space-y-3">
      <p className="text-sm text-slate-600">{target ? `Selection ${target.start + 1}–${target.end}` : `Whole sequence (${formatLength(length)})`}</p>
      <ErrorText>{error}</ErrorText>
      {busy && <p className="text-sm text-slate-500">Calculating…</p>}
      {result && (
        <>
          <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm sm:grid-cols-4">
            <Stat label="Length" value={`${result.length.toLocaleString("en")} ${kind === "aa" ? "aa" : "bp"}`} />
            {result.gc !== null && <Stat label="GC content" value={`${(result.gc * 100).toFixed(1)}%`} />}
            {result.tm !== null && <Stat label="Tm" value={`${result.tm.toFixed(1)} °C`} />}
            <Stat label="Mol. weight" value={`${(result.molecularWeight / 1000).toFixed(1)} kDa`} />
          </dl>
          <div>
            <h4 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-slate-500">Composition</h4>
            <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
              {Object.entries(result.counts)
                .sort((a, b) => b[1] - a[1])
                .map(([base, count]) => (
                  <span key={base} className="tabular-nums">
                    <span className="font-mono font-semibold">{base}</span>{" "}
                    <span className="text-slate-600">
                      {count} ({((count / result.length) * 100).toFixed(1)}%)
                    </span>
                  </span>
                ))}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs text-slate-500">{label}</dt>
      <dd className="font-medium tabular-nums">{value}</dd>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------

interface Suggestion {
  name: string;
  type: string;
  strand: 1 | -1 | 0;
  segments: { start: number; end: number }[];
  detail: string;
  source: "library" | "orf";
  color?: string;
}

function AnnotateTool({ entityId, onOverlays, onFeaturesChanged, readOnly }: Props) {
  const { result, error, busy, run } = useTool<{ suggestions: Suggestion[] }>(entityId);
  const [chosen, setChosen] = useState<Set<number>>(new Set());
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");
  const [minOrfAa, setMinOrfAa] = useState(0);

  useEffect(() => {
    run({ tool: "auto-annotate", minOrfAa });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!result) return;
    onOverlays(
      result.suggestions.map((s, i) => ({
        id: `sug-${i}`,
        kind: "match" as const,
        label: s.name,
        range: s.segments[0]!,
        strand: s.strand,
        color: s.color ?? OVERLAY_COLORS.match,
        detail: s.detail,
      })),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [result]);

  async function accept() {
    if (!result) return;
    setSaving(true);
    setSaveError("");
    try {
      await api("POST", `/entities/${entityId}/features`, {
        features: [...chosen].map((i) => {
          const s = result.suggestions[i]!;
          return { name: s.name, type: s.type, strand: s.strand, segments: s.segments, color: s.color };
        }),
      });
      setChosen(new Set());
      onFeaturesChanged();
      run({ tool: "auto-annotate", minOrfAa });
    } catch (e) {
      setSaveError(errorMessage(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-end gap-3">
        <label>
          <Label hint="0 to skip ORFs">Also suggest ORFs over (aa)</Label>
          <Input type="number" min={0} max={2000} value={minOrfAa} onChange={(e) => setMinOrfAa(Number(e.target.value))} className="w-36" />
        </label>
        <Button disabled={busy} onClick={() => run({ tool: "auto-annotate", minOrfAa })}>
          Scan
        </Button>
        {!readOnly && chosen.size > 0 && (
          <Button variant="primary" disabled={saving} onClick={accept}>
            Add {chosen.size} feature{chosen.size === 1 ? "" : "s"}
          </Button>
        )}
      </div>
      <ErrorText>{error || saveError}</ErrorText>
      {busy && <p className="text-sm text-slate-500">Scanning…</p>}

      {result && result.suggestions.length === 0 && (
        <p className="text-sm text-slate-500">Nothing new found. Everything the library recognises is already annotated.</p>
      )}
      {result && result.suggestions.length > 0 && (
        <ul className="divide-y divide-slate-100">
          {result.suggestions.map((s, i) => (
            <li key={i} className="flex items-center gap-3 py-1.5 text-sm">
              {!readOnly && (
                <input
                  type="checkbox"
                  checked={chosen.has(i)}
                  onChange={(e) => {
                    const next = new Set(chosen);
                    if (e.target.checked) next.add(i);
                    else next.delete(i);
                    setChosen(next);
                  }}
                />
              )}
              <span className="h-2.5 w-2.5 shrink-0 rounded-sm" style={{ background: s.color ?? OVERLAY_COLORS.match }} />
              <span className="font-medium">{s.name}</span>
              <Badge>{s.type}</Badge>
              <span className="tabular-nums text-slate-500">
                {s.segments[0]!.start + 1}–{s.segments[s.segments.length - 1]!.end}
              </span>
              <span className="ml-auto text-xs text-slate-500">{s.source === "orf" ? "reading frame" : "parts library"}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
