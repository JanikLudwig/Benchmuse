import Link from "next/link";
import { Icon } from "@/components/icons";
import { ItemTable } from "@/components/ItemTable";
import { NewProjectButton } from "@/components/NewProjectButton";
import { loadContext } from "@/server/pageContext";
import { listProjects } from "@/server/services/projects";
import { search } from "@/server/services/search";

export default async function HomePage() {
  const { db, actor } = await loadContext();
  const [projects, recent] = await Promise.all([
    listProjects(db),
    search(db, { filter: "type:IS_ONE_OF:entity,entry", sort: "modified_at:desc", limit: 10 }),
  ]);
  const firstName = actor.name.split(" ")[0];

  return (
    <div className="mx-auto max-w-6xl px-8 py-8">
      <div className="mb-8 flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Welcome back{firstName && `, ${firstName}`}</h1>
        <NewProjectButton />
      </div>

      <section className="mb-8">
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-slate-500">Projects</h2>
        {projects.length ? (
          <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {projects.map((p) => (
              <li key={p.id}>
                <Link
                  href={`/projects/${p.id}`}
                  className="flex h-full flex-col rounded-lg border border-slate-200 bg-white p-4 hover:border-brand-500 hover:shadow-sm"
                >
                  <span className="flex items-center gap-2 font-medium">
                    <Icon name="folder" className="h-4 w-4 text-brand-500" /> {p.name}
                  </span>
                  {p.description && <span className="mt-1 line-clamp-2 text-sm text-slate-500">{p.description}</span>}
                </Link>
              </li>
            ))}
          </ul>
        ) : (
          <p className="rounded-lg border border-dashed border-slate-300 bg-white p-8 text-center text-sm text-slate-500">
            No projects yet. Create one to start capturing entities and notebook entries.
          </p>
        )}
      </section>

      <section>
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-slate-500">Recently modified</h2>
        <div className="overflow-hidden rounded-lg border border-slate-200 bg-white">
          <ItemTable items={recent.items} empty="Nothing here yet." />
        </div>
      </section>
    </div>
  );
}
