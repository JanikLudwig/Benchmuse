"use client";

import { useCallback, useEffect, useState } from "react";
import { api, errorMessage } from "@/lib/api";
import { FieldInputs, type DropdownDef, type FieldDef, type Values } from "../FieldInputs";
import { Button, ErrorText } from "../ui";

interface Schema {
  id: string;
  name: string;
  fields: FieldDef[];
}

interface ResultRow {
  id: string;
  fields: Values;
}

/** Renders one result schema's rows for an entry, with an inline "add row" form. */
export function ResultsTableView({
  entryId,
  schemaId,
  readOnly,
  onRemove,
}: {
  entryId: string;
  schemaId: string;
  readOnly: boolean;
  onRemove: () => void;
}) {
  const [schema, setSchema] = useState<Schema | null>(null);
  const [dropdowns, setDropdowns] = useState<DropdownDef[]>([]);
  const [rows, setRows] = useState<ResultRow[]>([]);
  const [names, setNames] = useState<Record<string, string>>({});
  const [draft, setDraft] = useState<Values>({});
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState("");
  const [loadError, setLoadError] = useState("");

  const load = useCallback(async () => {
    try {
      const [s, d, r] = await Promise.all([
        api<Schema>("GET", `/schemas/${schemaId}`),
        api<{ items: DropdownDef[] }>("GET", "/dropdowns"),
        api<{ items: ResultRow[] }>("GET", `/results?entryId=${entryId}&schemaId=${schemaId}`),
      ]);
      // Resolve linked entity names before rendering, so rows never flash raw IDs.
      const ids = [
        ...new Set(
          r.items
            .flatMap((row) => Object.values(row.fields).flatMap((v) => (Array.isArray(v) ? v : [v])))
            .filter((v): v is string => typeof v === "string" && v.startsWith("ent_")),
        ),
      ];
      const found = ids.length
        ? (await api<{ items: { id: string; name: string; registryId: string | null }[] }>("GET", `/entities?ids=${ids.join(",")}`)).items
        : [];
      setNames(Object.fromEntries(found.map((e) => [e.id, e.registryId ? `${e.name} (${e.registryId})` : e.name])));
      setDropdowns(d.items);
      setRows(r.items);
      setSchema(s);
    } catch (e) {
      setLoadError(errorMessage(e));
    }
  }, [entryId, schemaId]);

  useEffect(() => {
    load();
  }, [load]);

  async function addRow() {
    setError("");
    try {
      await api("POST", "/results", { schemaId, entryId, rows: [draft] });
      setDraft({});
      setAdding(false);
      await load();
    } catch (e) {
      setError(errorMessage(e));
    }
  }

  if (loadError) return <ErrorText>Results table could not load: {loadError}</ErrorText>;
  if (!schema) return <div className="h-20 animate-pulse rounded-md bg-slate-100" />;

  const fields = schema.fields.filter((f) => !f.archivedAt);
  const optionNames = Object.fromEntries(dropdowns.flatMap((d) => d.options.map((o) => [o.id, o.name])));
  const show = (v: unknown): string => {
    if (v == null || v === "") return "";
    if (Array.isArray(v)) return v.map(show).join(", ");
    if (typeof v === "string") return names[v] ?? optionNames[v] ?? v;
    if (typeof v === "boolean") return v ? "Yes" : "No";
    return typeof v === "object" ? JSON.stringify(v) : String(v);
  };

  return (
    <div contentEditable={false} className="rounded-lg border border-slate-200 bg-white">
      <div className="flex items-center justify-between border-b border-slate-200 bg-slate-50 px-3 py-2">
        <span className="text-sm font-semibold">
          {schema.name} <span className="font-normal text-slate-500">· {rows.length} result{rows.length === 1 ? "" : "s"}</span>
        </span>
        {!readOnly && (
          <div className="flex gap-1">
            {!adding && <Button size="sm" onClick={() => setAdding(true)}>Add row</Button>}
            {rows.length === 0 && <Button size="sm" variant="ghost" onClick={onRemove}>Remove table</Button>}
          </div>
        )}
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="text-left text-xs text-slate-500">
            <tr>
              <th className="w-10 px-3 py-1.5 font-medium">#</th>
              {fields.map((f) => (
                <th key={f.id} className="px-3 py-1.5 font-medium">{f.displayName}</th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {rows.map((row, i) => (
              <tr key={row.id}>
                <td className="px-3 py-1.5 text-slate-400 tabular-nums">{i + 1}</td>
                {fields.map((f) => (
                  <td key={f.id} className="px-3 py-1.5 tabular-nums">{show(row.fields[f.name])}</td>
                ))}
              </tr>
            ))}
            {!rows.length && !adding && (
              <tr>
                <td colSpan={fields.length + 1} className="px-3 py-3 text-center text-slate-500">
                  No results yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      {adding && (
        <div className="space-y-3 border-t border-slate-200 p-3">
          <FieldInputs fields={fields} dropdowns={dropdowns} values={draft} onChange={(n, v) => setDraft((d) => ({ ...d, [n]: v }))} />
          <ErrorText>{error}</ErrorText>
          <div className="flex justify-end gap-2">
            <Button size="sm" onClick={() => { setAdding(false); setDraft({}); setError(""); }}>Cancel</Button>
            <Button size="sm" variant="primary" onClick={addRow}>Save row</Button>
          </div>
        </div>
      )}
    </div>
  );
}
