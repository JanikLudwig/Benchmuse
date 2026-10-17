"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { api, errorMessage } from "@/lib/api";
import { Button, ErrorText, Input, Label } from "./ui";

export function SignInForm() {
  const router = useRouter();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  return (
    <form
      action={async (form) => {
        setBusy(true);
        setError("");
        try {
          await api("POST", "/auth/session", {
            handleOrEmail: form.get("handleOrEmail"),
            password: form.get("password"),
          });
          router.replace("/");
          router.refresh();
        } catch (e) {
          setError(errorMessage(e));
          setBusy(false);
        }
      }}
      className="space-y-4 rounded-lg border border-slate-200 bg-white p-6 shadow-sm"
    >
      <h1 className="text-lg font-semibold">Sign in</h1>
      <label className="block">
        <Label required>Username or email</Label>
        <Input name="handleOrEmail" required autoFocus autoComplete="username" />
      </label>
      <label className="block">
        <Label required>Password</Label>
        <Input name="password" type="password" required autoComplete="current-password" />
      </label>
      <ErrorText>{error}</ErrorText>
      <Button type="submit" variant="primary" disabled={busy} className="w-full">
        {busy ? "Signing in…" : "Sign in"}
      </Button>
    </form>
  );
}

export function SetupForm() {
  const router = useRouter();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  return (
    <form
      action={async (form) => {
        setBusy(true);
        setError("");
        try {
          const password = String(form.get("password"));
          await api("POST", "/auth/setup", {
            handle: String(form.get("handle")).toLowerCase(),
            name: form.get("name"),
            email: form.get("email"),
            password,
          });
          // Sign straight in so the first administrator is not asked twice.
          await api("POST", "/auth/session", { handleOrEmail: form.get("handle"), password });
          router.replace("/");
          router.refresh();
        } catch (e) {
          setError(errorMessage(e));
          setBusy(false);
        }
      }}
      className="space-y-4 rounded-lg border border-slate-200 bg-white p-6 shadow-sm"
    >
      <div>
        <h1 className="text-lg font-semibold">Create the first account</h1>
        <p className="mt-1 text-sm text-slate-600">This instance has no users yet. The account you create here is an administrator.</p>
      </div>
      <label className="block">
        <Label required>Name</Label>
        <Input name="name" required autoFocus autoComplete="name" />
      </label>
      <label className="block">
        <Label required hint="lowercase, for @mentions">Username</Label>
        <Input name="handle" required pattern="[a-z0-9][a-z0-9-]{1,38}" autoComplete="username" />
      </label>
      <label className="block">
        <Label required>Email</Label>
        <Input name="email" type="email" required autoComplete="email" />
      </label>
      <label className="block">
        <Label required hint="at least 10 characters">Password</Label>
        <Input name="password" type="password" required minLength={10} autoComplete="new-password" />
      </label>
      <ErrorText>{error}</ErrorText>
      <Button type="submit" variant="primary" disabled={busy} className="w-full">
        {busy ? "Creating…" : "Create account"}
      </Button>
    </form>
  );
}
