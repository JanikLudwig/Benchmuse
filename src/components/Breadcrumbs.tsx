import Link from "next/link";
import { Icon } from "./icons";

export function Breadcrumbs({ path, current }: { path: { id: string; name: string }[]; current?: string }) {
  return (
    <nav aria-label="Breadcrumb" className="mb-2 flex flex-wrap items-center gap-1 text-sm text-slate-500">
      <Link href="/" className="hover:text-brand-600">Home</Link>
      {path.map((f) => (
        <span key={f.id} className="flex items-center gap-1">
          <Icon name="chevron" className="h-3 w-3" />
          <Link href={`/folders/${f.id}`} className="hover:text-brand-600">{f.name}</Link>
        </span>
      ))}
      {current && (
        <span className="flex items-center gap-1">
          <Icon name="chevron" className="h-3 w-3" />
          <span aria-current="page" className="text-slate-700">{current}</span>
        </span>
      )}
    </nav>
  );
}
