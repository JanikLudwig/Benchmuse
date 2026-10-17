import { NavRail } from "@/components/NavRail";
import { loadContext } from "@/server/pageContext";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  // Redirects to /signin when there is no valid session.
  const { actor } = await loadContext();
  return (
    <div className="flex h-dvh">
      <NavRail user={{ name: actor.name, handle: actor.handle, role: actor.role }} />
      <main className="min-w-0 flex-1 overflow-y-auto">{children}</main>
    </div>
  );
}
