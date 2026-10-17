import { redirect } from "next/navigation";
import { loadContext } from "@/server/pageContext";
import { getProjectRootFolder } from "@/server/services/projects";

/** A project is browsed through its root folder. */
export default async function ProjectPage(props: PageProps<"/projects/[id]">) {
  const { id } = await props.params;
  const { db } = await loadContext();
  const root = await getProjectRootFolder(db, id);
  redirect(`/folders/${root.id}`);
}
