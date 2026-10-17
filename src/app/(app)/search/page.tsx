import type { Metadata } from "next";
import Link from "next/link";
import { ItemTable } from "@/components/ItemTable";
import { serializeFilter, type FilterClause } from "@/server/domain/filters";
import { loadContext } from "@/server/pageContext";
import { AppError } from "@/server/services/errors";
import { listSchemas } from "@/server/services/schemas";
import { search, SEARCH_TYPES } from "@/server/services/search";

export const metadata: Metadata = { title: "Search" };

const PAGE_SIZE = 25;
const TYPE_LABEL: Record<string, string> = { entity: "Entities", entry: "Entries", folder: "Folders", project: "Projects" };

const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? "";

export default async function SearchPage(props: PageProps<"/search">) {
  const sp = await props.searchParams;
  const q = one(sp.q);
  const types = one(sp.type).split(",").filter((t) => (SEARCH_TYPES as readonly string[]).includes(t));
  const schemaId = one(sp.schema);
  const archived = one(sp.archived) === "1";
  const advanced = one(sp.filter);
  const sort = one(sp.sort) || (q ? "name:asc" : "modified_at:desc");
  const page = Math.max(1, Number(one(sp.page)) || 1);

  // Friendly controls compile to the same filter grammar the API accepts; `filter` adds raw clauses.
  const clauses: FilterClause[] = [];
  if (types.length) clauses.push({ property: "type", operator: "IS_ONE_OF", values: types });
  if (schemaId) clauses.push({ property: "schema", operator: "EQ", values: [schemaId] });
  if (archived) clauses.push({ property: "archived", operator: "IS_TRUE", values: [] });
  const filter = [serializeFilter(clauses), advanced].filter(Boolean).join(";");

  const { db } = await loadContext();
  const schemas = await listSchemas(db);
  let result: Awaited<ReturnType<typeof search>> | null = null;
  let error = "";
  try {
    result = await search(db, { q, filter, sort, limit: PAGE_SIZE, offset: (page - 1) * PAGE_SIZE });
  } catch (e) {
    if (!(e instanceof AppError)) throw e;
    error = e.message;
  }

  const href = (overrides: Record<string, string | null>) => {
    const params = new URLSearchParams();
    const base: Record<string, string> = { q, type: types.join(","), schema: schemaId, archived: archived ? "1" : "", filter: advanced, sort: one(sp.sort), page: "" };
    for (const [k, v] of Object.entries({ ...base, ...overrides })) if (v) params.set(k, v);
    return `/search?${params}`;
  };
  const toggleType = (t: string) => href({ type: (types.includes(t) ? types.filter((x) => x !== t) : [...types, t]).join(",") });
  const pages = result ? Math.max(1, Math.ceil(result.total / PAGE_SIZE)) : 1;

  return (
    <div className="mx-auto max-w-6xl px-8 py-8">
      <h1 className="mb-6 text-2xl font-semibold">Search</h1>
      <form action="/search" className="mb-4 flex flex-wrap gap-2">
        <input
          name="q"
          defaultValue={q}
          autoFocus
          placeholder="Name, registry ID, alias or object ID…"
          aria-label="Search"
          className="h-10 min-w-64 flex-1 rounded-md border border-slate-300 bg-white px-3 text-sm focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-100"
        />
        <select name="schema" defaultValue={schemaId} aria-label="Schema" className="h-10 rounded-md border border-slate-300 bg-white px-2 text-sm">
          <option value="">Any schema</option>
          {schemas.map((s) => (
            <option key={s.id} value={s.id}>{s.name}</option>
          ))}
        </select>
        {types.length > 0 && <input type="hidden" name="type" value={types.join(",")} />}
        {archived && <input type="hidden" name="archived" value="1" />}
        <button className="h-10 rounded-md bg-brand-600 px-4 text-sm font-medium text-white hover:bg-brand-700">Search</button>
        <details className="w-full text-sm" open={!!advanced}>
          <summary className="cursor-pointer text-slate-500">Advanced filter</summary>
          <input
            name="filter"
            defaultValue={advanced}
            placeholder="field.tm:GTE:58;registered:IS_TRUE"
            className="mt-2 h-9 w-full rounded-md border border-slate-300 bg-white px-3 font-mono text-xs"
          />
          <p className="mt-1 text-xs text-slate-500">
            Clauses <code>property:OPERATOR:value</code> joined by <code>;</code>. Properties: type, entity_type, schema, project, folder, creator, name, registry_id,
            created_at, modified_at, archived, registered, field.&lt;api_name&gt;. Operators: EQ, NEQ, IS_ONE_OF, CONTAINS, GT, GTE, LT, LTE, IS_TRUE, IS_FALSE, IS_EMPTY, IS_NOT_EMPTY.
          </p>
        </details>
      </form>

      <div className="mb-4 flex flex-wrap items-center gap-2 text-sm">
        {SEARCH_TYPES.map((t) => (
          <Link
            key={t}
            href={toggleType(t)}
            aria-pressed={types.includes(t)}
            className={`rounded-full border px-3 py-1 ${types.includes(t) ? "border-brand-500 bg-brand-50 text-brand-700" : "border-slate-300 bg-white text-slate-600 hover:border-slate-400"}`}
          >
            {TYPE_LABEL[t]}
          </Link>
        ))}
        <Link
          href={href({ archived: archived ? null : "1" })}
          aria-pressed={archived}
          className={`rounded-full border px-3 py-1 ${archived ? "border-red-300 bg-red-50 text-red-700" : "border-slate-300 bg-white text-slate-600 hover:border-slate-400"}`}
        >
          Archived only
        </Link>
        <span className="ml-auto text-slate-500">
          Sort:{" "}
          {[["modified_at:desc", "Recently modified"], ["name:asc", "Name"], ["registry_id:asc", "Registry ID"]].map(([value, label]) => (
            <Link key={value} href={href({ sort: value! })} className={`ml-2 ${sort === value ? "font-semibold text-slate-800" : "hover:text-brand-600"}`}>
              {label}
            </Link>
          ))}
        </span>
      </div>

      {error ? (
        <p role="alert" className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>
      ) : (
        result && (
          <>
            <p className="mb-2 text-sm text-slate-500">
              {result.total.toLocaleString("en")} result{result.total === 1 ? "" : "s"}
            </p>
            <div className="overflow-hidden rounded-lg border border-slate-200 bg-white">
              <ItemTable items={result.items} empty="No matches. Try fewer filters." />
            </div>
            {pages > 1 && (
              <nav aria-label="Pagination" className="mt-4 flex items-center justify-center gap-3 text-sm">
                {page > 1 ? <Link href={href({ page: String(page - 1) })} className="hover:text-brand-600">← Previous</Link> : <span className="text-slate-300">← Previous</span>}
                <span className="text-slate-500">Page {page} of {pages}</span>
                {page < pages ? <Link href={href({ page: String(page + 1) })} className="hover:text-brand-600">Next →</Link> : <span className="text-slate-300">Next →</span>}
              </nav>
            )}
          </>
        )
      )}
    </div>
  );
}
