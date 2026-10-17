import type { Metadata } from "next";
import { AuditTimeline } from "@/components/AuditTimeline";
import { Breadcrumbs } from "@/components/Breadcrumbs";
import { EntryEditor } from "@/components/notebook/EntryEditor";
import { EntryFields, EntryTitle } from "@/components/notebook/EntryHeader";
import { Badge } from "@/components/ui";
import { loadContext, orNotFound } from "@/server/pageContext";
import { listAudit } from "@/server/services/audit";
import { getEntityNames } from "@/server/services/entities";
import { getEntry } from "@/server/services/entries";
import { getFolderPath } from "@/server/services/projects";
import { getSchema, listDropdowns, listSchemas } from "@/server/services/schemas";
import { auditLabels, getUserNames, linkedIds } from "@/server/views";

export async function generateMetadata(props: PageProps<"/entries/[id]">): Promise<Metadata> {
  const { id } = await props.params;
  const { db } = await loadContext();
  return { title: (await orNotFound(getEntry(db, id))).name };
}

export default async function EntryPage(props: PageProps<"/entries/[id]">) {
  const { id } = await props.params;
  const { db } = await loadContext();
  const entry = await orNotFound(getEntry(db, id));
  const [path, schema, dropdowns, resultSchemas, audit] = await Promise.all([
    getFolderPath(db, entry.folderId),
    entry.schemaId ? getSchema(db, entry.schemaId) : null,
    listDropdowns(db),
    listSchemas(db, { kind: "result" }),
    listAudit(db, entry.id),
  ]);
  const [linkedNames, userNames] = await Promise.all([
    getEntityNames(db, linkedIds(entry.fields)),
    getUserNames(db, audit.map((a) => a.actorId)),
  ]);
  const { fieldLabels, optionNames } = auditLabels(schema, dropdowns);
  const archived = !!entry.archivedAt;

  return (
    <div className="mx-auto max-w-6xl px-8 py-8">
      <Breadcrumbs path={path} />
      <EntryTitle id={entry.id} name={entry.name} archived={archived} />
      <div className="mb-4 flex flex-wrap items-center gap-2 text-sm">
        <Badge tone="brand">{schema?.name ?? "Notebook entry"}</Badge>
        {archived && <Badge tone="red">Archived: {entry.archiveReason?.replace(/_/g, " ")}</Badge>}
        <span className="font-mono text-xs text-slate-400">{entry.id}</span>
      </div>
      {schema && schema.fields.length > 0 && (
        <EntryFields id={entry.id} fields={schema.fields} dropdowns={dropdowns} values={entry.fields} linkedNames={linkedNames} readOnly={archived} />
      )}
      <div className="grid grid-cols-1 gap-6 xl:grid-cols-4">
        <div className="xl:col-span-3">
          <EntryEditor entryId={entry.id} initialContent={entry.content} readOnly={archived} resultSchemas={resultSchemas.map((s) => ({ id: s.id, name: s.name }))} />
        </div>
        <div>
          <AuditTimeline events={audit} userNames={userNames} valueNames={{ ...optionNames, ...linkedNames }} fieldLabels={fieldLabels} />
        </div>
      </div>
    </div>
  );
}
