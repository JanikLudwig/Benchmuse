"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { api, errorMessage } from "@/lib/api";
import { Icon } from "./icons";
import { Button, Dialog, ErrorText, Input, Label } from "./ui";

export function NewProjectButton() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(form: FormData) {
    setBusy(true);
    setError("");
    try {
      const project = await api<{ id: string }>("POST", "/projects", {
        name: form.get("name"),
        description: form.get("description"),
      });
      router.push(`/projects/${project.id}`);
    } catch (e) {
      setError(errorMessage(e));
      setBusy(false);
    }
  }

  return (
    <>
      <Button variant="primary" onClick={() => setOpen(true)}>
        <Icon name="plus" /> New project
      </Button>
      <Dialog open={open} onClose={() => setOpen(false)} title="New project">
        <form action={submit} className="space-y-4">
          <label className="block">
            <Label required>Name</Label>
            <Input name="name" required autoFocus maxLength={200} placeholder="e.g. Antibody discovery Q4" />
          </label>
          <label className="block">
            <Label>Description</Label>
            <Input name="description" maxLength={5000} />
          </label>
          <ErrorText>{error}</ErrorText>
          <div className="flex justify-end gap-2">
            <Button type="button" onClick={() => setOpen(false)}>Cancel</Button>
            <Button type="submit" variant="primary" disabled={busy}>Create project</Button>
          </div>
        </form>
      </Dialog>
    </>
  );
}
