"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { api } from "@/lib/api";
import { Icon, type IconName } from "./icons";
import { cx } from "./ui";

const ITEMS: { href: string; label: string; icon: IconName; match: (p: string) => boolean }[] = [
  { href: "/", label: "Home", icon: "home", match: (p) => p === "/" || p.startsWith("/folders") || p.startsWith("/entities") || p.startsWith("/entries") },
  { href: "/search", label: "Search", icon: "search", match: (p) => p.startsWith("/search") },
  { href: "/schemas", label: "Schemas", icon: "schema", match: (p) => p.startsWith("/schemas") },
];

export function NavRail({ user }: { user: { name: string; handle: string; role: string } }) {
  const pathname = usePathname();
  const router = useRouter();
  const initials = user.name
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? "")
    .join("");
  return (
    <nav aria-label="Main" className="flex w-16 shrink-0 flex-col items-center gap-1 bg-brand-900 py-3">
      <Link href="/" className="mb-4 flex h-9 w-9 items-center justify-center rounded-lg bg-white/10 text-sm font-bold text-white" aria-label="Benchmuse home">
        B
      </Link>
      {ITEMS.map((item) => {
        const active = item.match(pathname);
        return (
          <Link
            key={item.href}
            href={item.href}
            aria-current={active ? "page" : undefined}
            className={cx(
              "flex w-14 flex-col items-center gap-0.5 rounded-lg py-2 text-[10px] font-medium",
              active ? "bg-white/15 text-white" : "text-indigo-200 hover:bg-white/10 hover:text-white",
            )}
          >
            <Icon name={item.icon} className="h-5 w-5" />
            {item.label}
          </Link>
        );
      })}

      <div className="mt-auto flex flex-col items-center gap-2">
        <button
          title={`${user.name} (${user.role}) — sign out`}
          aria-label={`Signed in as ${user.name}. Sign out`}
          onClick={async () => {
            await api("DELETE", "/auth/session").catch(() => undefined);
            router.replace("/signin");
            router.refresh();
          }}
          className="flex h-9 w-9 items-center justify-center rounded-full bg-emerald-600 text-xs font-semibold text-white hover:bg-emerald-700"
        >
          {initials || user.handle.slice(0, 2).toUpperCase()}
        </button>
      </div>
    </nav>
  );
}
