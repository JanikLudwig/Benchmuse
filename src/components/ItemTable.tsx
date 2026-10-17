import Link from "next/link";
import { Icon, iconForItem } from "./icons";

export interface ItemRow {
  id: string;
  type: "project" | "folder" | "entity" | "entry";
  name: string;
  entityType?: string | null;
  registryId?: string | null;
  modifiedAt: Date | string;
  archivedAt?: Date | string | null;
}

export function hrefFor(item: { id: string; type: string }): string {
  switch (item.type) {
    case "project": return `/projects/${item.id}`;
    case "folder": return `/folders/${item.id}`;
    case "entity": return `/entities/${item.id}`;
    default: return `/entries/${item.id}`;
  }
}

const TYPE_LABEL: Record<string, string> = {
  project: "Project",
  folder: "Folder",
  entry: "Notebook entry",
  custom: "Custom entity",
  dna_sequence: "DNA sequence",
  aa_sequence: "AA sequence",
};

export const typeLabel = (item: { type: string; entityType?: string | null }) =>
  TYPE_LABEL[item.type === "entity" ? (item.entityType ?? "custom") : item.type] ?? item.type;

const fmt = new Intl.DateTimeFormat("en", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" });

export function ItemTable({ items, empty }: { items: ItemRow[]; empty: string }) {
  if (!items.length) return <p className="px-4 py-8 text-center text-sm text-slate-500">{empty}</p>;
  return (
    <table className="w-full text-sm">
      <thead className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500">
        <tr>
          <th className="px-4 py-2 font-medium">Name</th>
          <th className="px-4 py-2 font-medium">Type</th>
          <th className="px-4 py-2 font-medium">Registry ID</th>
          <th className="px-4 py-2 text-right font-medium">Modified (UTC)</th>
        </tr>
      </thead>
      <tbody className="divide-y divide-slate-100">
        {items.map((item) => (
          <tr key={item.id} className="hover:bg-slate-50">
            <td className="px-4 py-2">
              <Link href={hrefFor(item)} className="flex items-center gap-2 font-medium text-slate-800 hover:text-brand-600">
                <Icon name={iconForItem(item)} className="h-4 w-4 shrink-0 text-slate-400" />
                <span className={item.archivedAt ? "text-slate-400 line-through" : undefined}>{item.name}</span>
              </Link>
            </td>
            <td className="px-4 py-2 text-slate-600">{typeLabel(item)}</td>
            <td className="px-4 py-2 font-mono text-xs text-slate-600">{item.registryId ?? ""}</td>
            <td className="px-4 py-2 text-right text-slate-500 tabular-nums">{fmt.format(new Date(item.modifiedAt))}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
