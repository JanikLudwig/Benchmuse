"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { api, errorMessage } from "@/lib/api";
import { FieldInputs, type DropdownDef, type FieldDef, type Values } from "./FieldInputs";
import { Icon } from "./icons";
import { Button, Dialog, ErrorText, Input, Label, Select } from "./ui";

export interface SchemaDef {
  id: string;
  name: string;
  kind: string;
  entityType: string | null;
  nameTemplate: string | null;
  fields: FieldDef[];
}

type Mode = null | "folder" | "entity" | "entry";

export function FolderActions({
  folderId,
  entitySchemas,
  entrySchemas,
  dropdowns,
}: {
  folderId: string;
  entitySchemas: SchemaDef[];
  entrySchemas: SchemaDef[];
  dropdowns: DropdownDef[];
}) {
  const [mode, setMode] = useState<Mode>(null);
  const close = () => setMode(null);
  return (
    <div className="flex gap-2">
      <Button onClick={() => setMode("folder")}>
        <Icon name="folder" /> Folder
      </Button>
      <Button onClick={() => setMode("entry")}>
        <Icon name="entry" /> Notebook entry
      </Button>
      <Button variant="primary" onClick={() => setMode("entity")}>
        <Icon name="plus" /> Entity
      </Button>
      <Dialog open={mode === "folder"} onClose={close} title="New folder">
        <NewFolderForm folderId={folderId} onDone={close} />
      </Dialog>
      <Dialog open={mode === "entry"} onClose={close} title="New notebook entry" wide>
        <NewEntryForm folderId={folderId} schemas={entrySchemas} dropdowns={dropdowns} onCancel={close} />
      </Dialog>
      <Dialog open={mode === "entity"} onClose={close} title="New entity" wide>
        <NewEntityForm folderId={folderId} schemas={entitySchemas} dropdowns={dropdowns} onCancel={close} />
      </Dialog>
    </div>
  );
}

function useSubmit() {
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  async function run(fn: () => Promise<void>) {
    setBusy(true);
    setError("");
    try {
      await fn();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  return { error, busy, run };
}

function NewFolderForm({ folderId, onDone }: { folderId: string; onDone: () => void }) {
  const router = useRouter();
  const { error, busy, run } = useSubmit();
  return (
    <form
      action={(form) =>
        run(async () => {
          await api("POST", "/folders", { name: form.get("name"), parentFolderId: folderId });
          onDone();
          router.refresh();
        })
      }
      className="space-y-4"
    >
      <label className="block">
        <Label required>Name</Label>
        <Input name="name" required autoFocus maxLength={200} />
      </label>
      <ErrorText>{error}</ErrorText>
      <div className="flex justify-end">
        <Button type="submit" variant="primary" disabled={busy}>Create folder</Button>
      </div>
    </form>
  );
}

const UNSCHEMATIZED = [
  { value: "type:dna_sequence", label: "DNA sequence (no schema)" },
  { value: "type:aa_sequence", label: "AA sequence (no schema)" },
];

function NewEntityForm({ folderId, schemas, dropdowns, onCancel }: { folderId: string; schemas: SchemaDef[]; dropdowns: DropdownDef[]; onCancel: () => void }) {
  const router = useRouter();
  const { error, busy, run } = useSubmit();
  const [choice, setChoice] = useState(schemas[0] ? `schema:${schemas[0].id}` : UNSCHEMATIZED[0]!.value);
  const [values, setValues] = useState<Values>({});
  const schema = choice.startsWith("schema:") ? schemas.find((s) => s.id === choice.slice(7)) : undefined;
  const entityType = schema ? schema.entityType : choice.slice(5);
  const hasSequence = entityType === "dna_sequence" || entityType === "aa_sequence";

  return (
    <form
      action={(form) =>
        run(async () => {
          const entity = await api<{ id: string }>("POST", "/entities", {
            name: form.get("name"),
            folderId,
            ...(schema ? { schemaId: schema.id, fields: values } : { entityType }),
            ...(hasSequence && { sequence: form.get("sequence") ?? "" }),
            ...(entityType === "dna_sequence" && { isCircular: form.get("isCircular") === "on" }),
          });
          router.push(`/entities/${entity.id}`);
        })
      }
      className="space-y-4"
    >
      <div className="grid grid-cols-2 gap-4">
        <label className="block">
          <Label required>Schema</Label>
          <Select value={choice} onChange={(e) => { setChoice(e.target.value); setValues({}); }}>
            {schemas.map((s) => (
              <option key={s.id} value={`schema:${s.id}`}>{s.name}</option>
            ))}
            {UNSCHEMATIZED.map((u) => (
              <option key={u.value} value={u.value}>{u.label}</option>
            ))}
          </Select>
        </label>
        <label className="block">
          <Label required>Name</Label>
          <Input name="name" required autoFocus maxLength={200} />
        </label>
      </div>
      {hasSequence && (
        <div>
          <label className="block">
            <Label hint={entityType === "dna_sequence" ? "IUPAC bases; whitespace and numbers are ignored" : "one-letter amino acid codes"}>Sequence</Label>
            <textarea name="sequence" rows={4} className="w-full rounded-md border border-slate-300 px-3 py-2 font-mono text-xs focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-100" />
          </label>
          {entityType === "dna_sequence" && (
            <label className="mt-2 flex items-center gap-2 text-sm">
              <input type="checkbox" name="isCircular" /> Circular (e.g. plasmid)
            </label>
          )}
        </div>
      )}
      {schema && (
        <fieldset>
          <legend className="mb-2 text-sm font-semibold text-slate-700">{schema.name} fields</legend>
          <FieldInputs fields={schema.fields} dropdowns={dropdowns} values={values} onChange={(n, v) => setValues((s) => ({ ...s, [n]: v }))} />
        </fieldset>
      )}
      <ErrorText>{error}</ErrorText>
      <div className="flex justify-end gap-2">
        <Button type="button" onClick={onCancel}>Cancel</Button>
        <Button type="submit" variant="primary" disabled={busy}>Create entity</Button>
      </div>
    </form>
  );
}

function NewEntryForm({ folderId, schemas, dropdowns, onCancel }: { folderId: string; schemas: SchemaDef[]; dropdowns: DropdownDef[]; onCancel: () => void }) {
  const router = useRouter();
  const { error, busy, run } = useSubmit();
  const [schemaId, setSchemaId] = useState("");
  const [values, setValues] = useState<Values>({});
  const schema = schemas.find((s) => s.id === schemaId);
  const today = new Date().toISOString().slice(0, 10);
  return (
    <form
      action={(form) =>
        run(async () => {
          const entry = await api<{ id: string }>("POST", "/entries", {
            name: form.get("name"),
            folderId,
            ...(schema && { schemaId: schema.id, fields: values }),
          });
          router.push(`/entries/${entry.id}`);
        })
      }
      className="space-y-4"
    >
      <div className="grid grid-cols-2 gap-4">
        <label className="block">
          <Label required>Name</Label>
          <Input name="name" required autoFocus maxLength={200} defaultValue={`${today} `} />
        </label>
        <label className="block">
          <Label>Entry schema</Label>
          <Select value={schemaId} onChange={(e) => { setSchemaId(e.target.value); setValues({}); }}>
            <option value="">None</option>
            {schemas.map((s) => (
              <option key={s.id} value={s.id}>{s.name}</option>
            ))}
          </Select>
        </label>
      </div>
      {schema && <FieldInputs fields={schema.fields} dropdowns={dropdowns} values={values} onChange={(n, v) => setValues((s) => ({ ...s, [n]: v }))} />}
      <ErrorText>{error}</ErrorText>
      <div className="flex justify-end gap-2">
        <Button type="button" onClick={onCancel}>Cancel</Button>
        <Button type="submit" variant="primary" disabled={busy}>Create entry</Button>
      </div>
    </form>
  );
}
