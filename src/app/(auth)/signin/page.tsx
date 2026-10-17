import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { SignInForm } from "@/components/SignInForm";
import { loadContext } from "@/server/pageContext";
import { countUsers } from "@/server/services/auth";

export const metadata: Metadata = { title: "Sign in" };

export default async function SignInPage() {
  const { db } = await loadContext({ requireUser: false });
  // A brand-new instance asks for its first administrator instead of a password.
  const needsSetup = (await countUsers(db)) === 0;
  if (needsSetup) redirect("/setup");
  return <SignInForm />;
}
