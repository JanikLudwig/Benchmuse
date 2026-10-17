"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { api, errorMessage } from "@/lib/api";
import { ArchiveButton } from "./ArchiveButton";
import { FieldInputs, type DropdownDef, type FieldDef, type Values } from "./FieldInputs";
import { Badge, Button, ErrorText, Input, Label, Select } from "./ui";

export interface EntityData {
  id: string;
  name: string;
  entityType: "custom" | "dna_sequence" | "rna_sequence" | "aa_sequence" | "dna_oligo";
  registryId: string | null;
  fields: Values;
  aliases: string[];
  sequence: string | null;
  isCircular: boolean;
  archivedAt: string | Date | null;
  archiveReason: string | null;
}

/** Register (if the schema has a name template) and archive/unarchive. */
export function EntityHeaderActions({ entity, canRegister }: { entity: EntityData; canRegister: boolean }) {
  const router = useRouter();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function register() {
    setBusy(true);
    setError("");
    try {
      await api("POST", `/entities/${entity.id}/register`);
      router.refresh();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col items-end gap-2">
      <div className="flex gap-2">
        {!entity.archivedAt && !entity.registryId && canRegister && (
          <Button variant="primary" disabled={busy} onClick={register}>Register</Button>
        )}
        <ArchiveButton id={entity.id} name={entity.name} archived={!!entity.archivedAt} what="entity" />
      </div>
      <ErrorText>{error}</ErrorText>
    </div>
  );
}

export function EntityFieldsPanel({
  entity,
  fields,
  dropdowns,
  linkedNames,
}: {
  entity: EntityData;
  fields: FieldDef[];
  dropdowns: DropdownDef[];
  linkedNames: Record<string, string>;
}) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(entity.name);
  const [aliases, setAliases] = useState(entity.aliases.join(", "));
  const [values, setValues] = useState<Values>(entity.fields);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const readOnly = !!entity.archivedAt;

  function reset() {
    setName(entity.name);
    setAliases(entity.aliases.join(", "));
    setValues(entity.fields);
    setError("");
    setEditing(false);
  }

  async function save() {
    setBusy(true);
    setError("");
    try {
      // Send only changed fields so the audit log records exactly what was edited.
      const changed = Object.fromEntries(
        Object.entries(values).filter(([k, v]) => JSON.stringify(v ?? null) !== JSON.stringify(entity.fields[k] ?? null)),
      );
      await api("PATCH", `/entities/${entity.id}`, {
        name,
        aliases: aliases.split(",").map((a) => a.trim()).filter(Boolean),
        ...(Object.keys(changed).length && { fields: changed }),
      });
      setEditing(false);
      router.refresh();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="rounded-lg border border-slate-200 bg-white p-5">
      <div className="mb-4 flex items-center justify-between">
        <h2 className="font-semibold">Details</h2>
        {!readOnly &&
          (editing ? (
            <div className="flex gap-2">
              <Button size="sm" onClick={reset}>Cancel</Button>
              <Button size="sm" variant="primary" disabled={busy} onClick={save}>Save</Button>
            </div>
          ) : (
            <Button size="sm" onClick={() => setEditing(true)}>Edit</Button>
          ))}
      </div>
      <div className="mb-4 grid grid-cols-1 gap-x-4 gap-y-3 sm:grid-cols-2">
        <label className="block">
          <Label required>Name</Label>
          <Input value={name} disabled={!editing} onChange={(e) => setName(e.target.value)} />
        </label>
        <label className="block">
          <Label hint="comma-separated">Aliases</Label>
          <Input value={aliases} disabled={!editing} onChange={(e) => setAliases(e.target.value)} />
        </label>
      </div>
      {fields.length > 0 && (
        <FieldInputs
          fields={fields}
          dropdowns={dropdowns}
          values={values}
          linkedNames={linkedNames}
          disabled={!editing}
          onChange={(n, v) => setValues((s) => ({ ...s, [n]: v }))}
        />
      )}
      <div className="mt-3">
        <ErrorText>{error}</ErrorText>
      </div>
    </section>
  );
}
