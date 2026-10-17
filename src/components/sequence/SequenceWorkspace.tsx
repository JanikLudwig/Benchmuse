"use client";

import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { api, errorMessage } from "@/lib/api";
import { Badge, Button, cx, Dialog, ErrorText, Input, Label } from "../ui";
import { FeatureTable } from "./FeatureTable";
import { LinearMap } from "./LinearMap";
import { PlasmidMap } from "./PlasmidMap";
import { SequenceText } from "./SequenceText";
import { ToolsPanel } from "./ToolsPanel";
import { formatLength, type Overlay, type Selection, type SequenceFeature } from "./model";

export interface SequenceEntity {
  id: string;
  name: string;
  registryId: string | null;
  entityType: "custom" | "dna_sequence" | "rna_sequence" | "aa_sequence" | "dna_oligo";
  sequence: string;
  isCircular: boolean;
  features: SequenceFeature[];
  archivedAt: string | Date | null;
}

type View = "map" | "sequence" | "split";

export function SequenceWorkspace({ entity }: { entity: SequenceEntity }) {
  const router = useRouter();
  const [selection, setSelection] = useState<Selection | null>(null);
  const [selectedFeatureId, setSelectedFeatureId] = useState<string | null>(null);
  const [overlays, setOverlays] = useState<Overlay[]>([]);
  const [view, setView] = useState<View>("split");
  const [showComplement, setShowComplement] = useState(false);
  const [scrollTo, setScrollTo] = useState<number | null>(null);
  const [goToOpen, setGoToOpen] = useState(false);
  const [error, setError] = useState("");

  const length = entity.sequence.length;
  const kind = entity.entityType === "aa_sequence" ? "aa" : "dna";
  const readOnly = !!entity.archivedAt || !!entity.registryId;

  // Selecting a feature selects the bases it covers, so tools act on it directly.
  const selectFeature = (id: string | null) => {
    setSelectedFeatureId(id);
    const feature = entity.features.find((f) => f.id === id);
    if (feature) {
      const first = feature.segments[0]!;
      const last = feature.segments[feature.segments.length - 1]!;
      setSelection({ start: first.start, end: last.end, strand: feature.strand === -1 ? -1 : 1 });
      setScrollTo(first.start);
    }
  };

  const selectedFeature = useMemo(
    () => entity.features.find((f) => f.id === selectedFeatureId) ?? null,
    [entity.features, selectedFeatureId],
  );

  async function act(action: string, body?: Record<string, unknown>) {
    setError("");
    try {
      await api("POST", `/entities/${entity.id}/sequence?action=${action}`, body ?? {});
      router.refresh();
    } catch (e) {
      setError(errorMessage(e));
    }
  }

  const selectionLength = selection ? selection.end - selection.start : 0;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex rounded-md border border-slate-300 bg-white p-0.5" role="group" aria-label="View">
          {(["map", "split", "sequence"] as View[]).map((v) => (
            <button
              key={v}
              onClick={() => setView(v)}
              aria-pressed={view === v}
              className={cx("rounded px-2.5 py-1 text-xs font-medium capitalize", view === v ? "bg-brand-600 text-white" : "text-slate-600 hover:bg-slate-100")}
            >
              {v}
            </button>
          ))}
        </div>

        {kind === "dna" && (
          <label className="flex items-center gap-1.5 text-xs text-slate-600">
            <input type="checkbox" checked={showComplement} onChange={(e) => setShowComplement(e.target.checked)} />
            complement
          </label>
        )}

        <Button size="sm" onClick={() => setGoToOpen(true)}>
          Go to…
        </Button>

        {selection && selectionLength > 0 && (
          <Badge tone="brand">
            {selection.start + 1}–{selection.end} · {formatLength(selectionLength)}
          </Badge>
        )}
        {selection && (
          <Button size="sm" variant="ghost" onClick={() => { setSelection(null); setSelectedFeatureId(null); }}>
            Clear selection
          </Button>
        )}

        <div className="ml-auto flex gap-2">
          <a
            href={`/api/v1/entities/${entity.id}/export?format=genbank`}
            className="inline-flex h-7 items-center rounded-md border border-slate-300 bg-white px-2.5 text-xs font-medium text-slate-700 hover:bg-slate-50"
          >
            Export GenBank
          </a>
          <a
            href={`/api/v1/entities/${entity.id}/export?format=fasta`}
            className="inline-flex h-7 items-center rounded-md border border-slate-300 bg-white px-2.5 text-xs font-medium text-slate-700 hover:bg-slate-50"
          >
            FASTA
          </a>
          {!readOnly && entity.isCircular && selection && (
            <Button size="sm" onClick={() => act("set-origin", { origin: selection.start })}>
              Set origin here
            </Button>
          )}
          {!readOnly && kind === "dna" && (
            <Button size="sm" onClick={() => act("flip")}>
              Reverse complement
            </Button>
          )}
        </div>
      </div>

      <ErrorText>{error}</ErrorText>
      {readOnly && (
        <p className="rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-600">
          {entity.registryId
            ? "This sequence is registered, so it cannot be edited. Create a new entity to make changes."
            : "This entity is archived and read-only."}
        </p>
      )}

      <div className={cx("grid items-start gap-4", view === "split" ? "lg:grid-cols-2" : "grid-cols-1")}>
        {(view === "map" || view === "split") && (
          <section className="rounded-lg border border-slate-200 bg-white p-4">
            {entity.isCircular ? (
              <PlasmidMap
                length={length}
                features={entity.features}
                overlays={overlays}
                selection={selection}
                selectedFeatureId={selectedFeatureId}
                onSelectFeature={selectFeature}
                onSelect={setSelection}
                title={entity.name}
              />
            ) : (
              <LinearMap
                length={length}
                features={entity.features}
                overlays={overlays}
                selection={selection}
                selectedFeatureId={selectedFeatureId}
                onSelectFeature={selectFeature}
                onSelect={setSelection}
              />
            )}
            {selectedFeature && (
              <div className="mt-3 rounded-md bg-slate-50 p-3 text-sm">
                <div className="flex items-center gap-2">
                  <strong>{selectedFeature.name}</strong>
                  <Badge>{selectedFeature.type}</Badge>
                  <span className="text-slate-500">
                    {selectedFeature.segments.map((s) => `${s.start + 1}–${s.end}`).join(", ")}
                  </span>
                </div>
                {Object.entries(selectedFeature.qualifiers ?? {}).slice(0, 4).map(([key, values]) => (
                  <p key={key} className="mt-1 text-xs text-slate-600">
                    <span className="font-medium">/{key}</span>{" "}
                    <span className="break-all">{values.join("; ").slice(0, 200)}</span>
                  </p>
                ))}
              </div>
            )}
          </section>
        )}

        {(view === "sequence" || view === "split") && (
          <section className="rounded-lg border border-slate-200 bg-white p-4">
            <SequenceText
              sequence={entity.sequence}
              features={entity.features}
              overlays={overlays}
              selection={selection}
              onSelect={setSelection}
              selectedFeatureId={selectedFeatureId}
              onSelectFeature={selectFeature}
              showComplement={showComplement}
              kind={kind}
              scrollTo={scrollTo}
            />
          </section>
        )}
      </div>

      <ToolsPanel
        entityId={entity.id}
        length={length}
        isCircular={entity.isCircular}
        kind={kind}
        selection={selection}
        onOverlays={setOverlays}
        onGoTo={(position) => {
          setScrollTo(position);
          setSelection({ start: position, end: position + 1, strand: 1 });
        }}
        onFeaturesChanged={() => router.refresh()}
        readOnly={readOnly}
      />

      <section className="rounded-lg border border-slate-200 bg-white p-4">
        <FeatureTable
          entityId={entity.id}
          features={entity.features}
          length={length}
          selectedFeatureId={selectedFeatureId}
          onSelectFeature={selectFeature}
          selection={selection}
          readOnly={readOnly}
          onChanged={() => router.refresh()}
        />
      </section>

      <Dialog open={goToOpen} onClose={() => setGoToOpen(false)} title="Go to position">
        <form
          action={(form) => {
            const from = Number(form.get("from"));
            const to = Number(form.get("to")) || from;
            if (!Number.isFinite(from) || from < 1 || from > length) return;
            setSelection({ start: from - 1, end: Math.min(length, Math.max(from, to)), strand: 1 });
            setScrollTo(from - 1);
            setGoToOpen(false);
          }}
          className="space-y-4"
        >
          <div className="grid grid-cols-2 gap-4">
            <label>
              <Label required>From</Label>
              <Input name="from" type="number" min={1} max={length} required autoFocus defaultValue={(selection?.start ?? 0) + 1} />
            </label>
            <label>
              <Label hint="optional">To</Label>
              <Input name="to" type="number" min={1} max={length} defaultValue={selection?.end} />
            </label>
          </div>
          <p className="text-xs text-slate-500">Positions are 1-based and inclusive, as shown in the ruler.</p>
          <div className="flex justify-end">
            <Button type="submit" variant="primary">
              Go
            </Button>
          </div>
        </form>
      </Dialog>
    </div>
  );
}
