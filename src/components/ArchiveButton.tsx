"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { api, errorMessage } from "@/lib/api";
import { Button, Dialog, ErrorText, Label, Select } from "./ui";

export const ARCHIVE_REASONS = [
  ["made_in_error", "Made in error"],
  ["retired", "Retired"],
  ["expended", "Expended"],
  ["shipped", "Shipped"],
  ["contaminated", "Contaminated"],
  ["expired", "Expired"],
  ["missing", "Missing"],
  ["other", "Other"],
] as const;

/** Archive (with a reason) or unarchive any archivable object. */
export function ArchiveButton({ id, name, archived, what }: { id: string; name: string; archived: boolean; what: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function run(fn: () => Promise<unknown>) {
    setBusy(true);
    setError("");
    try {
      await fn();
      setOpen(false);
      router.refresh();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  if (archived) {
    return (
      <div className="flex flex-col items-end gap-2">
        <Button disabled={busy} onClick={() => run(() => api("POST", "/unarchive", { ids: [id] }))}>Unarchive</Button>
        <ErrorText>{error}</ErrorText>
      </div>
    );
  }
  return (
    <>
      <Button variant="danger" disabled={busy} onClick={() => setOpen(true)}>Archive</Button>
      <Dialog open={open} onClose={() => setOpen(false)} title={`Archive ${name}`}>
        <form action={(form) => run(() => api("POST", "/archive", { ids: [id], reason: form.get("reason") }))} className="space-y-4">
          <p className="text-sm text-slate-600">
            Archived {what}s are hidden from default views and search, but keep their ID, history and links. You can unarchive later.
          </p>
          <label className="block">
            <Label required>Reason</Label>
            <Select name="reason" defaultValue="retired">
              {ARCHIVE_REASONS.map(([value, label]) => (
                <option key={value} value={value}>{label}</option>
              ))}
            </Select>
          </label>
          <ErrorText>{error}</ErrorText>
          <div className="flex justify-end gap-2">
            <Button type="button" onClick={() => setOpen(false)}>Cancel</Button>
            <Button type="submit" variant="danger" disabled={busy}>Archive</Button>
          </div>
        </form>
      </Dialog>
    </>
  );
}
