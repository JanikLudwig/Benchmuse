import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { SetupForm } from "@/components/SignInForm";
import { loadContext } from "@/server/pageContext";
import { countUsers } from "@/server/services/auth";

export const metadata: Metadata = { title: "Set up Benchmuse" };

export default async function SetupPage() {
  const { db } = await loadContext({ requireUser: false });
  if ((await countUsers(db)) > 0) redirect("/signin");
  return <SetupForm />;
}
