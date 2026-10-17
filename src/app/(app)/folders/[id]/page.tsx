import { Breadcrumbs } from "@/components/Breadcrumbs";
import { FolderActions } from "@/components/FolderActions";
import { ImportDialog } from "@/components/ImportDialog";
import { ItemTable, type ItemRow } from "@/components/ItemTable";
import { loadContext, orNotFound } from "@/server/pageContext";
import { getFolderPath, listFolderContents } from "@/server/services/projects";
import { listDropdowns, listSchemas } from "@/server/services/schemas";

export default async function FolderPage(props: PageProps<"/folders/[id]">) {
  const { id } = await props.params;
  const { db } = await loadContext();
  const path = await orNotFound(getFolderPath(db, id));
  const folder = path[path.length - 1]!;
  const [contents, entitySchemas, entrySchemas, dropdowns] = await Promise.all([
    listFolderContents(db, id),
    listSchemas(db, { kind: "entity" }),
    listSchemas(db, { kind: "entry" }),
    listDropdowns(db),
  ]);
  const items: ItemRow[] = [
    ...contents.folders.map((f) => ({ ...f, type: "folder" as const })),
    ...contents.entries.map((e) => ({ ...e, type: "entry" as const })),
    ...contents.entities.map((e) => ({ ...e, type: "entity" as const })),
  ];

  return (
    <div className="mx-auto max-w-6xl px-8 py-8">
      <Breadcrumbs path={path.slice(0, -1)} />
      <div className="mb-6 flex flex-wrap items-center justify-between gap-4">
        <h1 className="text-2xl font-semibold">{folder.name}</h1>
        {!folder.archivedAt && (
          <div className="flex flex-wrap gap-2">
            <ImportDialog folderId={folder.id} schemas={entitySchemas.map((s) => ({ id: s.id, name: s.name, entityType: s.entityType }))} />
            <FolderActions folderId={folder.id} entitySchemas={entitySchemas} entrySchemas={entrySchemas} dropdowns={dropdowns} />
          </div>
        )}
      </div>
      <div className="overflow-hidden rounded-lg border border-slate-200 bg-white">
        <ItemTable items={items} empty="This folder is empty. Add a folder, a notebook entry, or an entity." />
      </div>
    </div>
  );
}
