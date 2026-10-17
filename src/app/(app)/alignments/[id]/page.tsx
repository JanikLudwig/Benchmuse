import type { Metadata } from "next";
import { AlignmentViewer, type AlignmentData } from "@/components/alignment/AlignmentViewer";
import { Breadcrumbs } from "@/components/Breadcrumbs";
import { loadContext, orNotFound } from "@/server/pageContext";
import { getAlignmentView } from "@/server/services/alignments";
import { getFolderPath } from "@/server/services/projects";

export async function generateMetadata(props: PageProps<"/alignments/[id]">): Promise<Metadata> {
  const { id } = await props.params;
  const { db } = await loadContext();
  return { title: (await orNotFound(getAlignmentView(db, id))).alignment.name };
}

export default async function AlignmentPage(props: PageProps<"/alignments/[id]">) {
  const { id } = await props.params;
  const { db } = await loadContext();
  const view = await orNotFound(getAlignmentView(db, id));
  const path = view.alignment.folderId ? await getFolderPath(db, view.alignment.folderId) : [];

  return (
    <div className="mx-auto max-w-[1400px] px-8 py-8">
      <Breadcrumbs path={path} />
      <h1 className="mb-6 text-2xl font-semibold">{view.alignment.name}</h1>
      <AlignmentViewer data={view as unknown as AlignmentData} />
    </div>
  );
}
