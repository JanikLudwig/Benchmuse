"use client";

import { useState } from "react";
import { api, errorMessage } from "@/lib/api";
import { Badge, Button, ErrorText, Input, Label, Select, cx } from "../ui";
import {
  displayRange,
  featureColor,
  featureLength,
  formatLength,
  GENBANK_FEATURE_TYPES,
  type SequenceFeature,
} from "./model";

interface Props {
  entityId: string;
  features: SequenceFeature[];
  length: number;
  selectedFeatureId: string | null;
  onSelectFeature: (id: string | null) => void;
  /** current selection, offered as the range for a new feature */
  selection?: { start: number; end: number } | null;
  readOnly?: boolean;
  onChanged: () => void;
}

export function FeatureTable({
  entityId,
  features,
  length,
  selectedFeatureId,
  onSelectFeature,
  selection,
  readOnly,
  onChanged,
}: Props) {
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function save(next: SequenceFeature[]) {
    setBusy(true);
    setError("");
    try {
      await api("PUT", `/entities/${entityId}/features`, {
        features: next.map((f) => ({
          id: f.id,
          name: f.name,
          type: f.type,
          strand: f.strand,
          segments: f.segments,
          qualifiers: f.qualifiers,
          color: f.color,
        })),
      });
      setAdding(false);
      onChanged();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  const sorted = [...features].sort((a, b) => (a.segments[0]?.start ?? 0) - (b.segments[0]?.start ?? 0));

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold">
          Features <span className="font-normal text-slate-500">({features.length})</span>
        </h3>
        {!readOnly && !adding && (
          <Button size="sm" onClick={() => setAdding(true)}>
            Add feature
          </Button>
        )}
      </div>

      {adding && (
        <form
          action={(form) => {
            const start = Number(form.get("start")) - 1;
            const end = Number(form.get("end"));
            save([
              ...features,
              {
                id: `new-${Date.now()}`,
                name: String(form.get("name")),
                type: String(form.get("type")),
                strand: Number(form.get("strand")) as 1 | -1 | 0,
                segments: [{ start, end }],
              },
            ]);
          }}
          className="grid grid-cols-2 items-end gap-2 rounded-md bg-slate-50 p-3 sm:grid-cols-6"
        >
          <label className="col-span-2">
            <Label required>Name</Label>
            <Input name="name" required autoFocus />
          </label>
          <label>
            <Label required>Start</Label>
            <Input name="start" type="number" min={1} max={length} required defaultValue={selection ? selection.start + 1 : 1} />
          </label>
          <label>
            <Label required>End</Label>
            <Input name="end" type="number" min={1} max={length} required defaultValue={selection ? selection.end : Math.min(100, length)} />
          </label>
          <label>
            <Label>Type</Label>
            <Select name="type" defaultValue="misc_feature">
              {GENBANK_FEATURE_TYPES.map((t) => (
                <option key={t}>{t}</option>
              ))}
            </Select>
          </label>
          <label>
            <Label>Strand</Label>
            <Select name="strand" defaultValue="1">
              <option value="1">Forward</option>
              <option value="-1">Reverse</option>
              <option value="0">None</option>
            </Select>
          </label>
          <div className="col-span-2 flex gap-2 sm:col-span-6 sm:justify-end">
            <Button type="button" size="sm" onClick={() => setAdding(false)}>
              Cancel
            </Button>
            <Button type="submit" size="sm" variant="primary" disabled={busy}>
              Add
            </Button>
          </div>
        </form>
      )}

      <ErrorText>{error}</ErrorText>

      {sorted.length ? (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-left text-xs uppercase tracking-wide text-slate-500">
              <tr>
                <th className="py-1 font-medium">Name</th>
                <th className="py-1 font-medium">Type</th>
                <th className="py-1 font-medium">Position</th>
                <th className="py-1 font-medium">Length</th>
                <th className="py-1 font-medium">Strand</th>
                {!readOnly && <th />}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {sorted.map((feature) => (
                <tr
                  key={feature.id}
                  onClick={() => onSelectFeature(selectedFeatureId === feature.id ? null : feature.id)}
                  className={cx("cursor-pointer", selectedFeatureId === feature.id ? "bg-brand-50" : "hover:bg-slate-50")}
                >
                  <td className="py-1.5">
                    <span className="flex items-center gap-2 font-medium">
                      <span className="h-2.5 w-2.5 shrink-0 rounded-sm" style={{ background: featureColor(feature) }} />
                      {feature.name}
                    </span>
                  </td>
                  <td className="py-1.5">
                    <Badge>{feature.type}</Badge>
                  </td>
                  <td className="py-1.5 font-mono text-xs tabular-nums">
                    {feature.segments.map((s) => displayRange(s, length)).join(", ")}
                  </td>
                  <td className="py-1.5 tabular-nums text-slate-600">{formatLength(featureLength(feature, length))}</td>
                  <td className="py-1.5">{feature.strand === 1 ? "→" : feature.strand === -1 ? "←" : "–"}</td>
                  {!readOnly && (
                    <td className="py-1.5 text-right">
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={busy}
                        onClick={(e) => {
                          e.stopPropagation();
                          save(features.filter((f) => f.id !== feature.id));
                        }}
                      >
                        Remove
                      </Button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        !adding && <p className="text-sm text-slate-500">No features yet. Add one, or run auto-annotate from the Tools panel.</p>
      )}
    </div>
  );
}
