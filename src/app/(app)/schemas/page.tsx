import type { Metadata } from "next";
import Link from "next/link";
import { AddOptionInline, NewDropdownButton, NewSchemaButton } from "@/components/SchemaAdmin";
import { Badge } from "@/components/ui";
import { loadContext } from "@/server/pageContext";
import { listDropdowns, listSchemas } from "@/server/services/schemas";

export const metadata: Metadata = { title: "Schemas" };

const KINDS = [
  { kind: "entity", title: "Entity schemas", blurb: "What you register: plasmids, strains, antibodies, cell lines…" },
  { kind: "result", title: "Result schemas", blurb: "Structured assay data captured in notebook results tables." },
  { kind: "entry", title: "Entry schemas", blurb: "Metadata required on notebook entries." },
] as const;

const ENTITY_TYPE: Record<string, string> = { custom: "Custom", dna_sequence: "DNA", aa_sequence: "AA" };

export default async function SchemasPage() {
  const { db } = await loadContext();
  const [schemas, dropdowns] = await Promise.all([listSchemas(db), listDropdowns(db)]);

  return (
    <div className="mx-auto max-w-6xl px-8 py-8">
      <div className="mb-8 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Schemas</h1>
          <p className="mt-1 text-sm text-slate-500">Define the data model your lab works with. Every entity, result and entry is validated against its schema.</p>
        </div>
        <div className="flex gap-2">
          <NewDropdownButton />
          <NewSchemaButton />
        </div>
      </div>

      {KINDS.map(({ kind, title, blurb }) => {
        const rows = schemas.filter((s) => s.kind === kind);
        return (
          <section key={kind} className="mb-8">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500">{title}</h2>
            <p className="mb-3 text-sm text-slate-500">{blurb}</p>
            {rows.length ? (
              <ul className="divide-y divide-slate-100 overflow-hidden rounded-lg border border-slate-200 bg-white">
                {rows.map((s) => (
                  <li key={s.id}>
                    <Link href={`/schemas/${s.id}`} className="flex items-center justify-between gap-4 px-4 py-3 hover:bg-slate-50">
                      <span className="font-medium">{s.name}</span>
                      <span className="flex items-center gap-2 text-sm text-slate-500">
                        {s.entityType && <Badge tone="brand">{ENTITY_TYPE[s.entityType]}</Badge>}
                        {s.nameTemplate && <code className="rounded bg-slate-100 px-1.5 text-xs">{s.nameTemplate}</code>}
                        {s.fields.filter((f) => !f.archivedAt).length} fields
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="rounded-lg border border-dashed border-slate-300 bg-white p-4 text-sm text-slate-500">None yet.</p>
            )}
          </section>
        );
      })}

      <section>
        <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500">Dropdowns</h2>
        <p className="mb-3 text-sm text-slate-500">Controlled vocabularies shared by dropdown fields.</p>
        {dropdowns.length ? (
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            {dropdowns.map((d) => (
              <div key={d.id} className="rounded-lg border border-slate-200 bg-white p-4">
                <h3 className="mb-2 font-medium">{d.name}</h3>
                <div className="flex flex-wrap gap-1">
                  {d.options.map((o) => (
                    <Badge key={o.id}>{o.name}</Badge>
                  ))}
                </div>
                <AddOptionInline dropdownId={d.id} />
              </div>
            ))}
          </div>
        ) : (
          <p className="rounded-lg border border-dashed border-slate-300 bg-white p-4 text-sm text-slate-500">None yet.</p>
        )}
      </section>
    </div>
  );
}
