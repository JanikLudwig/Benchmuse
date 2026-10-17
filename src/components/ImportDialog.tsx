"use client";

import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { api, errorMessage } from "@/lib/api";
import { Icon } from "./icons";
import { Badge, Button, Dialog, ErrorText, Input, Label, Select } from "./ui";

interface Candidate {
  index: number;
  name: string;
  description?: string;
  entityType: string;
  length: number;
  isCircular: boolean;
  featureCount: number;
  preview: string;
  meanQuality?: number;
  trimmedLength?: number;
}

interface Preview {
  fileId: string;
  fileName: string;
  format: string;
  candidates: Candidate[];
  warnings: string[];
}

const TYPE_LABEL: Record<string, string> = {
  dna_sequence: "DNA",
  rna_sequence: "RNA",
  aa_sequence: "Protein",
  dna_oligo: "Oligo",
  custom: "Custom",
};

/**
 * Upload sequence files, show what they contain, and import the chosen records.
 *
 * Parsing happens before anything is written, so a scientist can see exactly what will be
 * created — and any warnings about the file — before committing.
 */
export function ImportDialog({ folderId, schemas }: { folderId: string; schemas: { id: string; name: string; entityType: string | null }[] }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [previews, setPreviews] = useState<Preview[]>([]);
  const [chosen, setChosen] = useState<Record<string, Set<number>>>({});
  const [schemaId, setSchemaId] = useState("");
  const [autoAnnotate, setAutoAnnotate] = useState(true);
  const [pasted, setPasted] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const fileInput = useRef<HTMLInputElement>(null);

  function reset() {
    setPreviews([]);
    setChosen({});
    setPasted("");
    setError("");
  }

  async function upload(files: FileList | null) {
    if (!files?.length) return;
    setBusy(true);
    setError("");
    try {
      const form = new FormData();
      for (const file of Array.from(files)) form.append("file", file);
      form.append("folderId", folderId);
      const res = await fetch("/api/v1/files", { method: "POST", body: form });
      const json = await res.json();
      if (!res.ok) throw new Error(json?.error?.message ?? "Upload failed");

      const loaded: Preview[] = [];
      for (const file of json.items as { id: string }[]) {
        loaded.push(await api<Preview>("GET", `/files/${file.id}/preview`));
      }
      setPreviews((current) => [...current, ...loaded]);
      // Everything is selected by default; the scientist unticks what they do not want.
      setChosen((current) => ({
        ...current,
        ...Object.fromEntries(loaded.map((p) => [p.fileId, new Set(p.candidates.map((c) => c.index))])),
      }));
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  async function commit() {
    setBusy(true);
    setError("");
    try {
      let created = 0;
      for (const preview of previews) {
        const indexes = [...(chosen[preview.fileId] ?? [])];
        if (!indexes.length) continue;
        const res = await api<{ items: unknown[] }>("POST", "/import", {
          fileId: preview.fileId,
          folderId,
          indexes,
          schemaId: schemaId || null,
          autoAnnotate,
        });
        created += res.items.length;
      }
      if (pasted.trim()) {
        const res = await api<{ items: unknown[] }>("POST", "/import/paste", {
          text: pasted,
          folderId,
          schemaId: schemaId || null,
          autoAnnotate,
        });
        created += res.items.length;
      }
      if (!created) {
        setError("Nothing selected to import.");
        return;
      }
      setOpen(false);
      reset();
      router.refresh();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  const totalSelected = Object.values(chosen).reduce((n, set) => n + set.size, 0) + (pasted.trim() ? 1 : 0);

  return (
    <>
      <Button onClick={() => setOpen(true)}>
        <Icon name="plus" /> Import sequences
      </Button>
      <Dialog
        open={open}
        onClose={() => {
          setOpen(false);
          reset();
        }}
        title="Import sequences"
        wide
      >
        <div className="space-y-4">
          <div
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
              e.preventDefault();
              upload(e.dataTransfer.files);
            }}
            className="rounded-lg border-2 border-dashed border-slate-300 p-6 text-center"
          >
            <p className="text-sm text-slate-600">Drop GenBank, FASTA or AB1 files here</p>
            <p className="mt-1 text-xs text-slate-500">.gb, .gbk, .fasta, .fa, .ab1 — several at once is fine</p>
            <input
              ref={fileInput}
              type="file"
              multiple
              accept=".gb,.gbk,.genbank,.ape,.fa,.fasta,.fna,.faa,.seq,.ab1,.abi,.fsa,.txt"
              className="hidden"
              onChange={(e) => upload(e.target.files)}
            />
            <Button className="mt-3" onClick={() => fileInput.current?.click()} disabled={busy}>
              Choose files
            </Button>
          </div>

          {previews.map((preview) => (
            <div key={preview.fileId} className="rounded-md border border-slate-200">
              <div className="flex items-center justify-between border-b border-slate-200 bg-slate-50 px-3 py-2">
                <span className="text-sm font-medium">{preview.fileName}</span>
                <Badge tone="brand">{preview.format}</Badge>
              </div>
              {preview.warnings.map((w) => (
                <p key={w} className="border-b border-amber-100 bg-amber-50 px-3 py-1.5 text-xs text-amber-800">
                  {w}
                </p>
              ))}
              {preview.candidates.length === 0 ? (
                <p className="px-3 py-2 text-sm text-slate-500">No sequences found in this file.</p>
              ) : (
                <ul className="divide-y divide-slate-100">
                  {preview.candidates.map((candidate) => (
                    <li key={candidate.index} className="flex items-start gap-3 px-3 py-2">
                      <input
                        type="checkbox"
                        className="mt-1"
                        checked={chosen[preview.fileId]?.has(candidate.index) ?? false}
                        onChange={(e) => {
                          const next = new Set(chosen[preview.fileId] ?? []);
                          if (e.target.checked) next.add(candidate.index);
                          else next.delete(candidate.index);
                          setChosen({ ...chosen, [preview.fileId]: next });
                        }}
                      />
                      <div className="min-w-0 flex-1">
                        <p className="font-medium">{candidate.name}</p>
                        <p className="text-xs text-slate-500">
                          {TYPE_LABEL[candidate.entityType] ?? candidate.entityType} · {candidate.length.toLocaleString("en")}{" "}
                          {candidate.entityType === "aa_sequence" ? "aa" : "bp"}
                          {candidate.isCircular && " · circular"}
                          {candidate.featureCount > 0 && ` · ${candidate.featureCount} features`}
                          {candidate.meanQuality !== undefined &&
                            ` · mean quality Q${candidate.meanQuality}, ${candidate.trimmedLength} bases after trimming`}
                        </p>
                        <code className="block truncate font-mono text-xs text-slate-400">{candidate.preview}…</code>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ))}

          <details>
            <summary className="cursor-pointer text-sm text-slate-600">Or paste a sequence</summary>
            <textarea
              value={pasted}
              onChange={(e) => setPasted(e.target.value)}
              rows={5}
              placeholder=">my sequence&#10;ATGAAAGGG…"
              className="mt-2 w-full rounded-md border border-slate-300 px-3 py-2 font-mono text-xs"
            />
          </details>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <label>
              <Label hint="optional">Apply schema</Label>
              <Select value={schemaId} onChange={(e) => setSchemaId(e.target.value)}>
                <option value="">No schema</option>
                {schemas.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </Select>
            </label>
            <label className="flex items-end gap-2 pb-2 text-sm">
              <input type="checkbox" checked={autoAnnotate} onChange={(e) => setAutoAnnotate(e.target.checked)} />
              Annotate known parts automatically
            </label>
          </div>

          <ErrorText>{error}</ErrorText>
          <div className="flex justify-end gap-2">
            <Button
              onClick={() => {
                setOpen(false);
                reset();
              }}
            >
              Cancel
            </Button>
            <Button variant="primary" disabled={busy || totalSelected === 0} onClick={commit}>
              Import {totalSelected > 0 ? `${totalSelected} sequence${totalSelected === 1 ? "" : "s"}` : ""}
            </Button>
          </div>
        </div>
      </Dialog>
    </>
  );
}
