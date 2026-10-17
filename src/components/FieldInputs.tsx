"use client";

import { useEffect, useRef, useState } from "react";
import { api } from "@/lib/api";
import { Input, Label, Select } from "./ui";

/** Client-side shapes (serialized from server rows). */
export interface FieldDef {
  id: string;
  name: string;
  displayName: string;
  type: string;
  isRequired: boolean;
  isMulti: boolean;
  dropdownId: string | null;
  targetSchemaId: string | null;
  archivedAt: string | Date | null;
}

export interface DropdownDef {
  id: string;
  name: string;
  options: { id: string; name: string; archivedAt: string | Date | null }[];
}

export type Values = Record<string, unknown>;

interface Props {
  fields: FieldDef[];
  dropdowns: DropdownDef[];
  values: Values;
  onChange: (name: string, value: unknown) => void;
  /** display names for entity IDs already present in `values` */
  linkedNames?: Record<string, string>;
  disabled?: boolean;
}

/** datetime-local works in local time without an offset; the API wants ISO 8601 with one. */
function isoToLocalInput(iso: unknown): string {
  if (typeof iso !== "string" || !iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

const asList = (v: unknown): unknown[] => (Array.isArray(v) ? v : v == null || v === "" ? [] : [v]);

export function FieldInputs({ fields, dropdowns, values, onChange, linkedNames = {}, disabled }: Props) {
  const live = fields.filter((f) => !f.archivedAt);
  if (!live.length) return <p className="text-sm text-slate-500">This schema has no fields.</p>;
  return (
    <div className="grid grid-cols-1 gap-x-4 gap-y-3 sm:grid-cols-2">
      {live.map((f) => (
        <div key={f.id} className={f.type === "long_text" || f.type === "json" || f.isMulti ? "sm:col-span-2" : undefined}>
          <Label htmlFor={`field-${f.id}`} id={`field-${f.id}-label`} required={f.isRequired} hint={f.isMulti ? "multiple" : undefined}>
            {f.displayName}
          </Label>
          <FieldInput field={f} dropdowns={dropdowns} value={values[f.name]} onChange={(v) => onChange(f.name, v)} linkedNames={linkedNames} disabled={disabled} />
        </div>
      ))}
    </div>
  );
}

function FieldInput({
  field,
  dropdowns,
  value,
  onChange,
  linkedNames,
  disabled,
}: {
  field: FieldDef;
  dropdowns: DropdownDef[];
  value: unknown;
  onChange: (v: unknown) => void;
  linkedNames: Record<string, string>;
  disabled?: boolean;
}) {
  const id = `field-${field.id}`;

  if (field.type === "entity_link") {
    return <EntityLinkInput id={id} field={field} value={value} onChange={onChange} linkedNames={linkedNames} disabled={disabled} />;
  }

  if (field.type === "dropdown") {
    const options = dropdowns.find((d) => d.id === field.dropdownId)?.options.filter((o) => !o.archivedAt || asList(value).includes(o.id)) ?? [];
    if (field.isMulti) {
      const selected = new Set(asList(value) as string[]);
      return (
        <div id={id} role="group" aria-labelledby={`${id}-label`} className="flex flex-wrap gap-x-4 gap-y-1 rounded-md border border-slate-200 bg-white px-3 py-2">
          {options.map((o) => (
            <label key={o.id} className="flex items-center gap-1.5 text-sm">
              <input
                type="checkbox"
                disabled={disabled}
                checked={selected.has(o.id)}
                onChange={(e) => {
                  const next = new Set(selected);
                  if (e.target.checked) next.add(o.id);
                  else next.delete(o.id);
                  onChange([...next]);
                }}
              />
              {o.name}
            </label>
          ))}
        </div>
      );
    }
    return (
      <Select id={id} disabled={disabled} value={(value as string) ?? ""} onChange={(e) => onChange(e.target.value || null)}>
        <option value="">—</option>
        {options.map((o) => (
          <option key={o.id} value={o.id}>
            {o.name}
          </option>
        ))}
      </Select>
    );
  }

  if (field.type === "boolean") {
    return (
      <Select id={id} disabled={disabled} value={value === true ? "true" : value === false ? "false" : ""} onChange={(e) => onChange(e.target.value === "" ? null : e.target.value === "true")}>
        <option value="">—</option>
        <option value="true">Yes</option>
        <option value="false">No</option>
      </Select>
    );
  }

  if (field.type === "json") {
    return <JsonInput id={id} value={value} onChange={onChange} disabled={disabled} />;
  }

  // Multi-valued scalars: one value per line.
  if (field.isMulti || field.type === "long_text") {
    const text = field.isMulti ? asList(value).map(String).join("\n") : ((value as string) ?? "");
    return (
      <textarea
        id={id}
        disabled={disabled}
        rows={field.isMulti ? 3 : 4}
        placeholder={field.isMulti ? "One value per line" : undefined}
        value={text}
        onChange={(e) => onChange(field.isMulti ? e.target.value.split("\n").map((s) => s.trim()).filter(Boolean) : e.target.value)}
        className="w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-100 disabled:border-slate-100 disabled:bg-slate-50"
      />
    );
  }

  if (field.type === "datetime") {
    return (
      <Input
        id={id}
        type="datetime-local"
        disabled={disabled}
        value={isoToLocalInput(value)}
        onChange={(e) => onChange(e.target.value ? new Date(e.target.value).toISOString() : null)}
      />
    );
  }

  const inputType = field.type === "date" ? "date" : field.type === "integer" || field.type === "float" ? "number" : "text";
  return (
    <Input
      id={id}
      type={inputType}
      step={field.type === "float" ? "any" : undefined}
      disabled={disabled}
      value={value == null ? "" : String(value)}
      onChange={(e) => onChange(e.target.value === "" ? null : e.target.value)}
    />
  );
}

function JsonInput({ id, value, onChange, disabled }: { id: string; value: unknown; onChange: (v: unknown) => void; disabled?: boolean }) {
  const [text, setText] = useState(value == null ? "" : JSON.stringify(value, null, 2));
  const [invalid, setInvalid] = useState(false);
  return (
    <>
      <textarea
        id={id}
        disabled={disabled}
        rows={4}
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          if (!e.target.value.trim()) {
            setInvalid(false);
            onChange(null);
            return;
          }
          try {
            onChange(JSON.parse(e.target.value));
            setInvalid(false);
          } catch {
            setInvalid(true);
          }
        }}
        className="w-full rounded-md border border-slate-300 bg-white px-3 py-2 font-mono text-xs focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-100 disabled:border-slate-100 disabled:bg-slate-50"
      />
      {invalid && <p className="mt-1 text-xs text-amber-700">Not valid JSON yet; the last valid value will be saved.</p>}
    </>
  );
}

interface SearchHit {
  id: string;
  name: string;
  registryId: string | null;
}

function EntityLinkInput({
  id,
  field,
  value,
  onChange,
  linkedNames,
  disabled,
}: {
  id: string;
  field: FieldDef;
  value: unknown;
  onChange: (v: unknown) => void;
  linkedNames: Record<string, string>;
  disabled?: boolean;
}) {
  const ids = asList(value) as string[];
  const [names, setNames] = useState<Record<string, string>>(linkedNames);
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [open, setOpen] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const selectedKey = ids.join(",");

  useEffect(() => {
    clearTimeout(timer.current);
    if (!open) return;
    timer.current = setTimeout(async () => {
      const filter = ["type:EQ:entity", field.targetSchemaId && `schema:EQ:${field.targetSchemaId}`].filter(Boolean).join(";");
      const params = new URLSearchParams({ filter, limit: "8", sort: "modified_at:desc", ...(query.trim() && { q: query.trim() }) });
      try {
        const res = await api<{ items: SearchHit[] }>("GET", `/search?${params}`);
        setHits(res.items.filter((h) => !selectedKey.split(",").includes(h.id)));
      } catch {
        setHits([]);
      }
    }, 150);
    return () => clearTimeout(timer.current);
  }, [query, open, field.targetSchemaId, selectedKey]);

  function pick(hit: SearchHit) {
    setNames((n) => ({ ...n, [hit.id]: hit.registryId ? `${hit.name} (${hit.registryId})` : hit.name }));
    onChange(field.isMulti ? [...ids, hit.id] : hit.id);
    setQuery("");
    setOpen(false);
  }

  const showInput = field.isMulti || !ids.length;
  return (
    <div className="relative">
      {ids.length > 0 && (
        <div className="mb-1 flex flex-wrap gap-1">
          {ids.map((id) => (
            <span key={id} className="inline-flex items-center gap-1 rounded bg-brand-50 px-2 py-0.5 text-xs font-medium text-brand-700">
              {names[id] ?? id}
              {!disabled && (
                <button
                  type="button"
                  aria-label={`Remove ${names[id] ?? id}`}
                  className="text-brand-500 hover:text-brand-900"
                  onClick={() => onChange(field.isMulti ? ids.filter((x) => x !== id) : null)}
                >
                  ✕
                </button>
              )}
            </span>
          ))}
        </div>
      )}
      {showInput && !disabled && (
        <Input
          id={id}
          role="combobox"
          aria-expanded={open}
          placeholder="Search entities by name or registry ID…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onFocus={() => setOpen(true)}
          onBlur={() => setTimeout(() => setOpen(false), 150)}
        />
      )}
      {open && hits.length > 0 && (
        <ul role="listbox" className="absolute z-20 mt-1 max-h-56 w-full overflow-auto rounded-md border border-slate-200 bg-white py-1 shadow-lg">
          {hits.map((h) => (
            <li key={h.id}>
              <button
                type="button"
                role="option"
                aria-selected={false}
                className="flex w-full items-center justify-between px-3 py-1.5 text-left text-sm hover:bg-brand-50"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => pick(h)}
              >
                <span>{h.name}</span>
                {h.registryId && <span className="font-mono text-xs text-slate-500">{h.registryId}</span>}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
