import Link from "next/link";
import { Icon, iconForItem } from "./icons";

export function Backlinks({
  entities,
  entries,
}: {
  entities: { id: string; name: string; registryId: string | null; entityType: string }[];
  entries: { id: string; name: string }[];
}) {
  return (
    <section className="rounded-lg border border-slate-200 bg-white p-5">
      <h2 className="mb-3 font-semibold">Linked from</h2>
      {entities.length + entries.length === 0 ? (
        <p className="text-sm text-slate-500">Nothing links here yet.</p>
      ) : (
        <ul className="space-y-1.5 text-sm">
          {entries.map((e) => (
            <li key={e.id}>
              <Link href={`/entries/${e.id}`} className="flex items-center gap-2 hover:text-brand-600">
                <Icon name="entry" className="h-4 w-4 text-slate-400" /> {e.name}
              </Link>
            </li>
          ))}
          {entities.map((e) => (
            <li key={e.id}>
              <Link href={`/entities/${e.id}`} className="flex items-center gap-2 hover:text-brand-600">
                <Icon name={iconForItem({ type: "entity", entityType: e.entityType })} className="h-4 w-4 text-slate-400" />
                {e.name}
                {e.registryId && <span className="font-mono text-xs text-slate-500">{e.registryId}</span>}
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
