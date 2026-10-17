import type { Metadata } from "next";
import Link from "next/link";
import { AddFieldForm, FieldsTable, SchemaSettings } from "@/components/SchemaAdmin";
import { Badge } from "@/components/ui";
import { loadContext, orNotFound } from "@/server/pageContext";
import { getSchema, listDropdowns, listSchemas } from "@/server/services/schemas";

export async function generateMetadata(props: PageProps<"/schemas/[id]">): Promise<Metadata> {
  const { id } = await props.params;
  const { db } = await loadContext();
  return { title: (await orNotFound(getSchema(db, id))).name };
}

const KIND_LABEL: Record<string, string> = { entity: "Entity schema", result: "Result schema", entry: "Entry schema" };

export default async function SchemaPage(props: PageProps<"/schemas/[id]">) {
  const { id } = await props.params;
  const { db } = await loadContext();
  const schema = await orNotFound(getSchema(db, id));
  const [dropdowns, entitySchemas] = await Promise.all([listDropdowns(db), listSchemas(db, { kind: "entity" })]);
  const schemaNames = Object.fromEntries(entitySchemas.map((s) => [s.id, s.name]));

  return (
    <div className="mx-auto max-w-6xl space-y-6 px-8 py-8">
      <div>
        <Link href="/schemas" className="text-sm text-slate-500 hover:text-brand-600">← Schemas</Link>
        <h1 className="mt-1 text-2xl font-semibold">{schema.name}</h1>
        <div className="mt-2 flex items-center gap-2">
          <Badge tone="brand">{KIND_LABEL[schema.kind]}</Badge>
          {schema.entityType && <Badge>{schema.entityType.replace("_", " ")}</Badge>}
          <span className="font-mono text-xs text-slate-400">{schema.id}</span>
        </div>
      </div>
      <SchemaSettings schema={schema} />
      <FieldsTable schemaId={schema.id} fields={schema.fields} dropdowns={dropdowns} schemaNames={schemaNames} />
      <AddFieldForm schemaId={schema.id} dropdowns={dropdowns} entitySchemas={entitySchemas.map((s) => ({ id: s.id, name: s.name }))} />
    </div>
  );
}
