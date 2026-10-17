"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { api, errorMessage } from "@/lib/api";
import type { DropdownDef, FieldDef } from "./FieldInputs";
import { Icon } from "./icons";
import { Badge, Button, Dialog, ErrorText, Input, Label, Select } from "./ui";

const FIELD_TYPES = [
  ["text", "Text"],
  ["long_text", "Long text"],
  ["integer", "Integer"],
  ["float", "Decimal"],
  ["boolean", "Yes / No"],
  ["date", "Date"],
  ["datetime", "Date & time"],
  ["dropdown", "Dropdown"],
  ["entity_link", "Entity link"],
  ["json", "JSON"],
] as const;

export const fieldTypeLabel = (t: string) => FIELD_TYPES.find(([v]) => v === t)?.[1] ?? t;

/** "Concentration (ng/µL)" -> "concentration_ng_l": a valid API name suggestion. */
const toApiName = (display: string) =>
  display.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").replace(/^(\d)/, "f_$1").slice(0, 63);

function useAction() {
  const router = useRouter();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  async function run(fn: () => Promise<unknown>, after?: () => void) {
    setBusy(true);
    setError("");
    try {
      await fn();
      after?.();
      router.refresh();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  return { error, busy, run, router };
}

export function NewSchemaButton() {
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState("entity");
  const { error, busy, run, router } = useAction();
  return (
    <>
      <Button variant="primary" onClick={() => setOpen(true)}>
        <Icon name="plus" /> New schema
      </Button>
      <Dialog open={open} onClose={() => setOpen(false)} title="New schema">
        <form
          action={(form) =>
            run(async () => {
              const schema = await api<{ id: string }>("POST", "/schemas", {
                kind,
                name: form.get("name"),
                description: form.get("description"),
                ...(kind === "entity" && {
                  entityType: form.get("entityType"),
                  nameTemplate: String(form.get("nameTemplate") ?? "").trim() || null,
                }),
              });
              router.push(`/schemas/${schema.id}`);
            })
          }
          className="space-y-4"
        >
          <div className="grid grid-cols-2 gap-4">
            <label className="block">
              <Label required>Kind</Label>
              <Select value={kind} onChange={(e) => setKind(e.target.value)}>
                <option value="entity">Entity (registry)</option>
                <option value="result">Result (assay data)</option>
                <option value="entry">Notebook entry</option>
              </Select>
            </label>
            <label className="block">
              <Label required>Name</Label>
              <Input name="name" required autoFocus placeholder="e.g. Plasmid" />
            </label>
          </div>
          {kind === "entity" && (
            <div className="grid grid-cols-2 gap-4">
              <label className="block">
                <Label required>Entity type</Label>
                <Select name="entityType" defaultValue="custom">
                  <option value="custom">Custom entity</option>
                  <option value="dna_sequence">DNA sequence</option>
                  <option value="aa_sequence">AA sequence</option>
                </Select>
              </label>
              <label className="block">
                <Label hint="optional">Registry ID template</Label>
                <Input name="nameTemplate" placeholder="PLS-{n:4}" className="font-mono" />
              </label>
              <p className="col-span-2 -mt-2 text-xs text-slate-500">
                Tokens: <code>{"{n}"}</code> or <code>{"{n:4}"}</code> (zero-padded counter, required), <code>{"{yyyy}"}</code>, <code>{"{yy}"}</code>, <code>{"{mm}"}</code>, <code>{"{dd}"}</code>.
                Leave empty if these entities are never registered.
              </p>
            </div>
          )}
          <label className="block">
            <Label>Description</Label>
            <Input name="description" />
          </label>
          <ErrorText>{error}</ErrorText>
          <div className="flex justify-end gap-2">
            <Button type="button" onClick={() => setOpen(false)}>Cancel</Button>
            <Button type="submit" variant="primary" disabled={busy}>Create schema</Button>
          </div>
        </form>
      </Dialog>
    </>
  );
}

export function NewDropdownButton() {
  const [open, setOpen] = useState(false);
  const { error, busy, run } = useAction();
  return (
    <>
      <Button onClick={() => setOpen(true)}>
        <Icon name="plus" /> New dropdown
      </Button>
      <Dialog open={open} onClose={() => setOpen(false)} title="New dropdown">
        <form
          action={(form) =>
            run(
              () =>
                api("POST", "/dropdowns", {
                  name: form.get("name"),
                  options: String(form.get("options") ?? "").split("\n").map((o) => o.trim()).filter(Boolean),
                }),
              () => setOpen(false),
            )
          }
          className="space-y-4"
        >
          <label className="block">
            <Label required>Name</Label>
            <Input name="name" required autoFocus placeholder="e.g. Antibiotic resistance" />
          </label>
          <label className="block">
            <Label hint="one per line">Options</Label>
            <textarea name="options" rows={5} className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-100" />
          </label>
          <ErrorText>{error}</ErrorText>
          <div className="flex justify-end">
            <Button type="submit" variant="primary" disabled={busy}>Create dropdown</Button>
          </div>
        </form>
      </Dialog>
    </>
  );
}

export function AddOptionInline({ dropdownId }: { dropdownId: string }) {
  const [value, setValue] = useState("");
  const { error, busy, run } = useAction();
  return (
    <form
      action={() => run(() => api("POST", `/dropdowns/${dropdownId}/options`, { name: value }), () => setValue(""))}
      className="mt-2 flex gap-2"
    >
      <Input value={value} onChange={(e) => setValue(e.target.value)} placeholder="Add option…" className="h-7 text-xs" />
      <Button size="sm" type="submit" disabled={busy || !value.trim()}>Add</Button>
      {error && <span className="text-xs text-red-600">{error}</span>}
    </form>
  );
}

export function SchemaSettings({ schema }: { schema: { id: string; name: string; description: string; kind: string; nameTemplate: string | null } }) {
  const { error, busy, run } = useAction();
  return (
    <form
      action={(form) =>
        run(() =>
          api("PATCH", `/schemas/${schema.id}`, {
            name: form.get("name"),
            description: form.get("description"),
            ...(schema.kind === "entity" && { nameTemplate: String(form.get("nameTemplate") ?? "").trim() || null }),
          }),
        )
      }
      className="grid grid-cols-1 gap-4 rounded-lg border border-slate-200 bg-white p-5 sm:grid-cols-3"
    >
      <label className="block">
        <Label required>Name</Label>
        <Input name="name" defaultValue={schema.name} required />
      </label>
      {schema.kind === "entity" && (
        <label className="block">
          <Label hint="e.g. PLS-{n:4}">Registry ID template</Label>
          <Input name="nameTemplate" defaultValue={schema.nameTemplate ?? ""} className="font-mono" />
        </label>
      )}
      <label className="block">
        <Label>Description</Label>
        <Input name="description" defaultValue={schema.description} />
      </label>
      <div className="flex items-center justify-end gap-3 sm:col-span-3">
        <ErrorText>{error}</ErrorText>
        <Button type="submit" disabled={busy}>Save settings</Button>
      </div>
    </form>
  );
}

export function FieldsTable({
  schemaId,
  fields,
  dropdowns,
  schemaNames,
}: {
  schemaId: string;
  fields: FieldDef[];
  dropdowns: DropdownDef[];
  schemaNames: Record<string, string>;
}) {
  const { error, busy, run } = useAction();
  const patch = (fieldId: string, body: Record<string, unknown>) => run(() => api("PATCH", `/schemas/${schemaId}/fields/${fieldId}`, body));
  const dropdownName = (id: string | null) => dropdowns.find((d) => d.id === id)?.name;
  return (
    <div className="rounded-lg border border-slate-200 bg-white">
      <table className="w-full text-sm">
        <thead className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500">
          <tr>
            <th className="px-4 py-2 font-medium">Field</th>
            <th className="px-4 py-2 font-medium">API name</th>
            <th className="px-4 py-2 font-medium">Type</th>
            <th className="px-4 py-2 font-medium">Required</th>
            <th className="px-4 py-2" />
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {fields.map((f) => (
            <tr key={f.id} className={f.archivedAt ? "text-slate-400" : undefined}>
              <td className="px-4 py-2 font-medium">
                {f.displayName} {f.archivedAt && <Badge>archived</Badge>}
              </td>
              <td className="px-4 py-2 font-mono text-xs">{f.name}</td>
              <td className="px-4 py-2">
                {fieldTypeLabel(f.type)}
                {f.isMulti && <span className="text-slate-500"> (multiple)</span>}
                {f.type === "dropdown" && <span className="text-slate-500"> · {dropdownName(f.dropdownId)}</span>}
                {f.type === "entity_link" && <span className="text-slate-500"> → {f.targetSchemaId ? schemaNames[f.targetSchemaId] : "any entity"}</span>}
              </td>
              <td className="px-4 py-2">
                <input
                  type="checkbox"
                  aria-label={`${f.displayName} required`}
                  checked={f.isRequired}
                  disabled={busy || !!f.archivedAt}
                  onChange={(e) => patch(f.id, { isRequired: e.target.checked })}
                />
              </td>
              <td className="px-4 py-2 text-right">
                <Button size="sm" variant="ghost" disabled={busy} onClick={() => patch(f.id, { archived: !f.archivedAt })}>
                  {f.archivedAt ? "Restore" : "Archive"}
                </Button>
              </td>
            </tr>
          ))}
          {!fields.length && (
            <tr>
              <td colSpan={5} className="px-4 py-6 text-center text-slate-500">No fields yet.</td>
            </tr>
          )}
        </tbody>
      </table>
      {error && <div className="p-3"><ErrorText>{error}</ErrorText></div>}
    </div>
  );
}

export function AddFieldForm({
  schemaId,
  dropdowns,
  entitySchemas,
}: {
  schemaId: string;
  dropdowns: DropdownDef[];
  entitySchemas: { id: string; name: string }[];
}) {
  const [displayName, setDisplayName] = useState("");
  const [name, setName] = useState("");
  const [nameTouched, setNameTouched] = useState(false);
  const [type, setType] = useState("text");
  const { error, busy, run } = useAction();

  return (
    <form
      action={(form) =>
        run(
          () =>
            api("POST", `/schemas/${schemaId}/fields`, {
              displayName,
              name: nameTouched ? name : toApiName(displayName),
              type,
              isRequired: form.get("isRequired") === "on",
              isMulti: form.get("isMulti") === "on",
              ...(type === "dropdown" && { dropdownId: form.get("dropdownId") || null }),
              ...(type === "entity_link" && { targetSchemaId: form.get("targetSchemaId") || null }),
            }),
          () => {
            setDisplayName("");
            setName("");
            setNameTouched(false);
          },
        )
      }
      className="space-y-3 rounded-lg border border-slate-200 bg-white p-5"
    >
      <h3 className="font-semibold">Add field</h3>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-4">
        <label className="block">
          <Label required>Display name</Label>
          <Input value={displayName} onChange={(e) => setDisplayName(e.target.value)} required placeholder="Concentration (ng/µL)" />
        </label>
        <label className="block">
          <Label required>API name</Label>
          <Input
            value={nameTouched ? name : toApiName(displayName)}
            onChange={(e) => {
              setNameTouched(true);
              setName(e.target.value);
            }}
            className="font-mono"
          />
        </label>
        <label className="block">
          <Label required>Type</Label>
          <Select value={type} onChange={(e) => setType(e.target.value)}>
            {FIELD_TYPES.map(([v, l]) => (
              <option key={v} value={v}>{l}</option>
            ))}
          </Select>
        </label>
        {type === "dropdown" && (
          <label className="block">
            <Label required>Dropdown</Label>
            <Select name="dropdownId" required>
              <option value="">Choose…</option>
              {dropdowns.map((d) => (
                <option key={d.id} value={d.id}>{d.name}</option>
              ))}
            </Select>
          </label>
        )}
        {type === "entity_link" && (
          <label className="block">
            <Label>Links to</Label>
            <Select name="targetSchemaId">
              <option value="">Any entity</option>
              {entitySchemas.map((s) => (
                <option key={s.id} value={s.id}>{s.name}</option>
              ))}
            </Select>
          </label>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-4 text-sm">
        <label className="flex items-center gap-1.5"><input type="checkbox" name="isRequired" /> Required</label>
        <label className="flex items-center gap-1.5"><input type="checkbox" name="isMulti" /> Allow multiple values</label>
        <span className="ml-auto text-xs text-slate-500">A field&apos;s type can&apos;t change later; archive it and add a new one instead.</span>
        <Button type="submit" variant="primary" disabled={busy || !displayName.trim()}>Add field</Button>
      </div>
      <ErrorText>{error}</ErrorText>
    </form>
  );
}
