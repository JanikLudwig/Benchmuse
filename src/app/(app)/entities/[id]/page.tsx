import type { Metadata } from "next";
import Link from "next/link";
import { AuditTimeline } from "@/components/AuditTimeline";
import { Backlinks } from "@/components/Backlinks";
import { Breadcrumbs } from "@/components/Breadcrumbs";
import { EntityFieldsPanel, EntityHeaderActions, type EntityData } from "@/components/EntityDetail";
import { typeLabel } from "@/components/ItemTable";
import { LineagePanel } from "@/components/LineagePanel";
import { SequenceWorkspace, type SequenceEntity } from "@/components/sequence/SequenceWorkspace";
import { Badge } from "@/components/ui";
import { formatLength } from "@/components/sequence/model";
import { loadContext, orNotFound } from "@/server/pageContext";
import { listAudit } from "@/server/services/audit";
import { getBacklinks, getEntity, getEntityNames } from "@/server/services/entities";
import { getLineageGraph } from "@/server/services/lineage";
import { listAlignments } from "@/server/services/alignments";
import { getFolderPath } from "@/server/services/projects";
import { getSchema, listDropdowns } from "@/server/services/schemas";
import { auditLabels, getUserNames, linkedIds } from "@/server/views";

export async function generateMetadata(props: PageProps<"/entities/[id]">): Promise<Metadata> {
  const { id } = await props.params;
  const { db } = await loadContext();
  const entity = await orNotFound(getEntity(db, id));
  return { title: entity.registryId ? `${entity.registryId} ${entity.name}` : entity.name };
}

const ENTITY_TYPE_LABEL: Record<string, string> = {
  custom: "Custom entity",
  dna_sequence: "DNA sequence",
  rna_sequence: "RNA sequence",
  aa_sequence: "Protein sequence",
  dna_oligo: "Oligo",
};

export default async function EntityPage(props: PageProps<"/entities/[id]">) {
  const { id } = await props.params;
  const { db } = await loadContext();
  const entity = await orNotFound(getEntity(db, id));
  const [path, schema, dropdowns, audit, backlinks, lineage, alignments] = await Promise.all([
    getFolderPath(db, entity.folderId),
    entity.schemaId ? getSchema(db, entity.schemaId) : null,
    listDropdowns(db),
    listAudit(db, entity.id),
    getBacklinks(db, entity.id),
    getLineageGraph(db, entity.id, 2),
    listAlignments(db, { referenceEntityId: entity.id, limit: 10 }),
  ]);
  const auditValueIds = audit.flatMap((a) => Object.values(a.changes).flatMap((c) => linkedIds({ from: c.from, to: c.to })));
  const [linkedNames, userNames] = await Promise.all([
    getEntityNames(db, [...linkedIds(entity.fields), ...auditValueIds]),
    getUserNames(db, audit.map((a) => a.actorId)),
  ]);
  const { fieldLabels, optionNames } = auditLabels(schema, dropdowns);

  const hasSequence = !!entity.sequence;
  const data = entity as unknown as EntityData;

  return (
    <div className="mx-auto max-w-[1600px] px-8 py-8">
      <Breadcrumbs path={path} />
      <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">{entity.name}</h1>
          <div className="mt-2 flex flex-wrap items-center gap-2 text-sm">
            {entity.registryId ? <Badge tone="green">{entity.registryId}</Badge> : <Badge tone="amber">Unregistered</Badge>}
            <Badge tone="brand">{schema?.name ?? ENTITY_TYPE_LABEL[entity.entityType] ?? typeLabel({ type: "entity", entityType: entity.entityType })}</Badge>
            {hasSequence && (
              <span className="text-slate-500">
                {formatLength(entity.sequence!.length)} · {entity.isCircular ? "circular" : "linear"}
              </span>
            )}
            {entity.oligoRole && <Badge>{entity.oligoRole.replace("_", " ")}</Badge>}
            {entity.archivedAt && <Badge tone="red">Archived: {entity.archiveReason?.replace(/_/g, " ")}</Badge>}
            <span className="font-mono text-xs text-slate-400">{entity.id}</span>
          </div>
        </div>
        <EntityHeaderActions entity={data} canRegister={!!schema?.nameTemplate} />
      </div>

      <div className="grid grid-cols-1 gap-6 xl:grid-cols-4">
        <div className="space-y-6 xl:col-span-3">
          <EntityFieldsPanel entity={data} fields={schema?.fields ?? []} dropdowns={dropdowns} linkedNames={linkedNames} />
          {hasSequence && (
            <SequenceWorkspace
              entity={{
                id: entity.id,
                name: entity.name,
                registryId: entity.registryId,
                entityType: entity.entityType,
                sequence: entity.sequence!,
                isCircular: entity.isCircular,
                features: entity.features,
                archivedAt: entity.archivedAt,
              } satisfies SequenceEntity}
            />
          )}
        </div>

        <div className="space-y-6">
          {alignments.length > 0 && (
            <section className="rounded-lg border border-slate-200 bg-white p-5">
              <h2 className="mb-3 font-semibold">Sequencing</h2>
              <ul className="space-y-1.5 text-sm">
                {alignments.map((a) => (
                  <li key={a.id}>
                    <Link href={`/alignments/${a.id}`} className="hover:text-brand-600">
                      {a.name}
                      <span className="ml-1.5 text-xs text-slate-500">
                        {a.placedCount}/{a.readCount} reads · {a.variantCount} difference{a.variantCount === 1 ? "" : "s"}
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            </section>
          )}
          <LineagePanel entityId={entity.id} nodes={lineage.nodes} edges={lineage.edges} />
          <Backlinks {...backlinks} />
          <AuditTimeline events={audit} userNames={userNames} valueNames={{ ...optionNames, ...linkedNames }} fieldLabels={fieldLabels} />
        </div>
      </div>
    </div>
  );
}
