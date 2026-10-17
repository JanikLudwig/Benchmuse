import Link from "next/link";
import type { ConstructMethod } from "@/server/db/schema";
import { Icon, iconForItem } from "./icons";

interface Node {
  entityId: string;
  name: string;
  registryId: string | null;
  entityType: string;
}

interface Edge {
  parentEntityId: string | null;
  childEntityId: string;
  method: ConstructMethod;
  role: string | null;
}

const METHOD_LABEL: Record<string, string> = {
  restriction_ligation: "restriction cloning",
  gibson: "Gibson assembly",
  golden_gate: "Golden Gate",
  pcr: "PCR",
  mutagenesis: "mutagenesis",
  synthesis: "synthesis",
  manual_edit: "manual edit",
  import: "imported",
};

/** Where this construct came from, and what was built from it. */
export function LineagePanel({ entityId, nodes, edges }: { entityId: string; nodes: Node[]; edges: Edge[] }) {
  const byId = new Map(nodes.map((n) => [n.entityId, n]));
  const parents = edges.filter((e) => e.childEntityId === entityId);
  const children = edges.filter((e) => e.parentEntityId === entityId);

  if (!parents.length && !children.length) return null;

  return (
    <section className="rounded-lg border border-slate-200 bg-white p-5">
      <h2 className="mb-3 font-semibold">Lineage</h2>

      {parents.length > 0 && (
        <div className="mb-3">
          <h3 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-slate-500">Made from</h3>
          <ul className="space-y-1.5 text-sm">
            {parents.map((edge, i) => {
              const parent = edge.parentEntityId ? byId.get(edge.parentEntityId) : null;
              return (
                <li key={i} className="flex items-start gap-2">
                  <Icon name={parent ? iconForItem({ type: "entity", entityType: parent.entityType }) : "archive"} className="mt-0.5 h-4 w-4 shrink-0 text-slate-400" />
                  <span>
                    {parent ? (
                      <Link href={`/entities/${parent.entityId}`} className="font-medium hover:text-brand-600">
                        {parent.name}
                      </Link>
                    ) : (
                      <span className="text-slate-600">{METHOD_LABEL[edge.method] ?? edge.method}</span>
                    )}
                    <span className="text-xs text-slate-500">
                      {parent ? ` · ${METHOD_LABEL[edge.method] ?? edge.method}` : ""}
                      {edge.role ? ` (${edge.role})` : ""}
                    </span>
                  </span>
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {children.length > 0 && (
        <div>
          <h3 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-slate-500">Used to make</h3>
          <ul className="space-y-1.5 text-sm">
            {children.map((edge, i) => {
              const child = byId.get(edge.childEntityId);
              if (!child) return null;
              return (
                <li key={i} className="flex items-start gap-2">
                  <Icon name={iconForItem({ type: "entity", entityType: child.entityType })} className="mt-0.5 h-4 w-4 shrink-0 text-slate-400" />
                  <span>
                    <Link href={`/entities/${child.entityId}`} className="font-medium hover:text-brand-600">
                      {child.name}
                    </Link>
                    <span className="text-xs text-slate-500"> · {METHOD_LABEL[edge.method] ?? edge.method}</span>
                  </span>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </section>
  );
}
