"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { api, errorMessage } from "@/lib/api";
import { ArchiveButton } from "../ArchiveButton";
import { FieldInputs, type DropdownDef, type FieldDef, type Values } from "../FieldInputs";
import { Button, ErrorText } from "../ui";

/** Inline-editable entry title plus archive control. */
export function EntryTitle({ id, name, archived }: { id: string; name: string; archived: boolean }) {
  const router = useRouter();
  const [value, setValue] = useState(name);
  const [error, setError] = useState("");

  async function commit() {
    const next = value.trim();
    if (!next || next === name) {
      setValue(name);
      return;
    }
    try {
      await api("PATCH", `/entries/${id}`, { name: next });
      router.refresh();
    } catch (e) {
      setError(errorMessage(e));
      setValue(name);
    }
  }

  return (
    <div className="mb-2 flex flex-wrap items-start justify-between gap-4">
      <div className="min-w-0 flex-1">
        <input
          aria-label="Entry name"
          value={value}
          disabled={archived}
          onChange={(e) => setValue(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
          className="-ml-1.5 w-full rounded-md border border-transparent bg-transparent px-1.5 py-0.5 text-2xl font-semibold hover:border-slate-200 focus:border-brand-500 focus:bg-white focus:outline-none"
        />
        <ErrorText>{error}</ErrorText>
      </div>
      <ArchiveButton id={id} name={name} archived={archived} what="entry" />
    </div>
  );
}

export function EntryFields({
  id,
  fields,
  dropdowns,
  values,
  linkedNames,
  readOnly,
}: {
  id: string;
  fields: FieldDef[];
  dropdowns: DropdownDef[];
  values: Values;
  linkedNames: Record<string, string>;
  readOnly: boolean;
}) {
  const router = useRouter();
  const [draft, setDraft] = useState<Values>(values);
  const [error, setError] = useState("");
  const dirty = JSON.stringify(draft) !== JSON.stringify(values);

  async function save() {
    setError("");
    try {
      await api("PATCH", `/entries/${id}`, { fields: draft });
      router.refresh();
    } catch (e) {
      setError(errorMessage(e));
    }
  }

  return (
    <section className="mb-6 rounded-lg border border-slate-200 bg-white p-5">
      <FieldInputs fields={fields} dropdowns={dropdowns} values={draft} linkedNames={linkedNames} disabled={readOnly} onChange={(n, v) => setDraft((d) => ({ ...d, [n]: v }))} />
      <ErrorText>{error}</ErrorText>
      {dirty && !readOnly && (
        <div className="mt-3 flex justify-end gap-2">
          <Button size="sm" onClick={() => setDraft(values)}>Discard</Button>
          <Button size="sm" variant="primary" onClick={save}>Save fields</Button>
        </div>
      )}
    </section>
  );
}
