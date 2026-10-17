import { sql, type SQL } from "drizzle-orm";
import type { Db } from "../db/client";
import { parseFilter, parseSort, type FilterClause, type SortClause } from "../domain/filters";
import { ValidationError } from "./errors";

export const SEARCH_TYPES = ["project", "folder", "entity", "entry"] as const;
export type SearchType = (typeof SEARCH_TYPES)[number];

export interface SearchItem {
  id: string;
  type: SearchType;
  name: string;
  entityType: string | null;
  registryId: string | null;
  schemaId: string | null;
  projectId: string;
  folderId: string | null;
  createdById: string;
  createdAt: string;
  modifiedAt: string;
  archivedAt: string | null;
  archiveReason: string | null;
}

export interface SearchParams {
  q?: string | null;
  filter?: string | null;
  sort?: string | null;
  limit?: number;
  offset?: number;
}

/**
 * Common projection over every searchable table. `folder_id` is the containing folder
 * (for folders: their parent), so `folder:EQ:<id>` lists a folder's direct children.
 */
const SEARCHABLE = sql`
  select p.id, 'project' as type, p.name, null::text as entity_type, null::text as registry_id, null::text as schema_id,
         p.id as project_id, null::text as folder_id, '{}'::jsonb as fields, '{}'::text[] as aliases,
         p.created_by_id, p.created_at, p.modified_at, p.archived_at, p.archive_reason
    from projects p
  union all
  select f.id, 'folder', f.name, null, null, null, f.project_id, f.parent_folder_id, '{}'::jsonb, '{}'::text[],
         f.created_by_id, f.created_at, f.modified_at, f.archived_at, f.archive_reason
    from folders f where f.parent_folder_id is not null
  union all
  select e.id, 'entity', e.name, e.entity_type, e.registry_id, e.schema_id, fo.project_id, e.folder_id, e.fields, e.aliases,
         e.created_by_id, e.created_at, e.modified_at, e.archived_at, e.archive_reason
    from entities e join folders fo on fo.id = e.folder_id
  union all
  select n.id, 'entry', n.name, null, null, n.schema_id, fo.project_id, n.folder_id, n.fields, '{}'::text[],
         n.created_by_id, n.created_at, n.modified_at, n.archived_at, n.archive_reason
    from entries n join folders fo on fo.id = n.folder_id
`;

const COLUMN: Record<string, SQL> = {
  type: sql`s.type`,
  entity_type: sql`s.entity_type`,
  schema: sql`s.schema_id`,
  project: sql`s.project_id`,
  folder: sql`s.folder_id`,
  creator: sql`s.created_by_id`,
  name: sql`s.name`,
  registry_id: sql`s.registry_id`,
  created_at: sql`s.created_at`,
  modified_at: sql`s.modified_at`,
};

const TIMESTAMP_PROPS = new Set(["created_at", "modified_at"]);
const ID_PROPS = new Set(["type", "entity_type", "schema", "project", "folder", "creator"]);

const fail = (clause: FilterClause, why: string): never => {
  throw new ValidationError(`Unsupported filter '${clause.property}:${clause.operator}': ${why}`);
};

function compare(op: string, left: SQL, right: SQL): SQL {
  switch (op) {
    case "GT": return sql`${left} > ${right}`;
    case "GTE": return sql`${left} >= ${right}`;
    case "LT": return sql`${left} < ${right}`;
    case "LTE": return sql`${left} <= ${right}`;
    default: throw new Error(`not a comparison: ${op}`);
  }
}

const escapeLike = (v: string) => `%${v.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

function fieldCondition(clause: FilterClause, fieldName: string): SQL {
  const json = sql`s.fields -> ${fieldName}`;
  const text = sql`s.fields ->> ${fieldName}`;
  const [v] = clause.values;
  // A field holds a scalar or (multi-valued) an array; equality matches either shape.
  const eqOne = (value: string) => sql`(${text} = ${value} or (jsonb_typeof(${json}) = 'array' and ${json} @> jsonb_build_array(${value}::text)))`;
  switch (clause.operator) {
    case "EQ": return eqOne(v!);
    case "NEQ": return sql`not coalesce(${eqOne(v!)}, false)`;
    case "IS_ONE_OF": return sql`(${sql.join(clause.values.map(eqOne), sql` or `)})`;
    case "CONTAINS": return sql`${text} ilike ${escapeLike(v!)}`;
    case "IS_EMPTY": return sql`(${json} is null or ${json} = 'null'::jsonb or ${json} = '[]'::jsonb)`;
    case "IS_NOT_EMPTY": return sql`not (${json} is null or ${json} = 'null'::jsonb or ${json} = '[]'::jsonb)`;
    case "IS_TRUE": return sql`${json} = 'true'::jsonb`;
    case "IS_FALSE": return sql`${json} = 'false'::jsonb`;
    case "GT": case "GTE": case "LT": case "LTE": {
      const numeric = Number(v);
      if (v!.trim() !== "" && Number.isFinite(numeric)) {
        return sql`(jsonb_typeof(${json}) = 'number' and ${compare(clause.operator, sql`(${text})::numeric`, sql`${numeric}::numeric`)})`;
      }
      // Dates/datetimes are stored as ISO strings, which order correctly as text.
      return sql`(jsonb_typeof(${json}) = 'string' and ${compare(clause.operator, text, sql`${v}`)})`;
    }
  }
}

function clauseCondition(clause: FilterClause): SQL | null {
  if (clause.property === "archived") {
    if (clause.operator === "IS_TRUE") return sql`s.archived_at is not null`;
    if (clause.operator === "IS_FALSE") return sql`s.archived_at is null`;
    return fail(clause, "use IS_TRUE or IS_FALSE");
  }
  if (clause.property === "registered") {
    if (clause.operator === "IS_TRUE") return sql`s.registry_id is not null`;
    if (clause.operator === "IS_FALSE") return sql`(s.type = 'entity' and s.registry_id is null)`;
    return fail(clause, "use IS_TRUE or IS_FALSE");
  }
  if (clause.property.startsWith("field.")) return fieldCondition(clause, clause.property.slice("field.".length));

  const col = COLUMN[clause.property] ?? fail(clause, "unknown property");
  const [v] = clause.values;
  if (clause.property === "type" && clause.values.some((t) => !SEARCH_TYPES.includes(t as SearchType))) {
    fail(clause, `type must be one of ${SEARCH_TYPES.join(", ")}`);
  }
  if (TIMESTAMP_PROPS.has(clause.property)) {
    if (!["GT", "GTE", "LT", "LTE"].includes(clause.operator)) fail(clause, "timestamps support GT, GTE, LT, LTE");
    if (Number.isNaN(Date.parse(v!))) fail(clause, "expected an ISO 8601 timestamp");
    return compare(clause.operator, col, sql`${new Date(v!).toISOString()}::timestamptz`);
  }
  switch (clause.operator) {
    case "EQ": return sql`${col} = ${v}`;
    case "NEQ": return sql`${col} is distinct from ${v}`;
    case "IS_ONE_OF": return sql`${col} in (${sql.join(clause.values.map((x) => sql`${x}`), sql`, `)})`;
    case "IS_EMPTY": return sql`${col} is null`;
    case "IS_NOT_EMPTY": return sql`${col} is not null`;
    case "CONTAINS":
      if (ID_PROPS.has(clause.property)) fail(clause, "CONTAINS is only for text properties");
      return sql`${col} ilike ${escapeLike(v!)}`;
    default:
      return fail(clause, "operator not supported for this property");
  }
}

const SORTABLE: Record<string, SQL> = {
  name: sql`lower(s.name)`,
  registry_id: sql`s.registry_id`,
  type: sql`s.type`,
  created_at: sql`s.created_at`,
  modified_at: sql`s.modified_at`,
};

function orderBy(sorts: SortClause[]): SQL {
  const parts = (sorts.length ? sorts : [{ property: "modified_at", direction: "desc" as const }]).map((s) => {
    const col = SORTABLE[s.property];
    if (!col) throw new ValidationError(`Cannot sort by '${s.property}'; sortable: ${Object.keys(SORTABLE).join(", ")}`);
    return s.direction === "desc" ? sql`${col} desc nulls last` : sql`${col} asc nulls last`;
  });
  return sql.join([...parts, sql`s.id asc`], sql`, `); // id: stable tiebreak for paging
}

export async function search(db: Db, params: SearchParams) {
  const filter = parseFilter(params.filter);
  if (!filter.ok) throw new ValidationError(`Invalid filter: ${filter.error}`);
  const sort = parseSort(params.sort);
  if (!sort.ok) throw new ValidationError(`Invalid sort: ${sort.error}`);
  const limit = Math.min(Math.max(params.limit ?? 50, 1), 200);
  const offset = Math.max(params.offset ?? 0, 0);

  const conditions = filter.value.map(clauseCondition).filter((c): c is SQL => c !== null);
  if (!filter.value.some((c) => c.property === "archived")) conditions.push(sql`s.archived_at is null`);
  const q = params.q?.trim();
  if (q) {
    const like = escapeLike(q);
    conditions.push(
      sql`(s.name ilike ${like} or s.registry_id ilike ${like} or s.id = ${q} or exists (select 1 from unnest(s.aliases) a where a ilike ${like}))`,
    );
  }
  const where = sql.join(conditions, sql` and `);

  // Both drivers (PGlite, node-postgres) return `{ rows }`; the generic Db type can't express that.
  const result = (await db.execute(sql`
    select s.id, s.type, s.name, s.entity_type, s.registry_id, s.schema_id, s.project_id, s.folder_id,
           s.created_by_id, s.created_at, s.modified_at, s.archived_at, s.archive_reason,
           count(*) over() as total
      from (${SEARCHABLE}) s
     where ${where}
     order by ${orderBy(sort.value)}
     limit ${limit} offset ${offset}`)) as unknown as { rows: Record<string, unknown>[] };

  const rows = result.rows;
  const iso = (v: unknown) => (v == null ? null : new Date(v as string).toISOString());
  const items: SearchItem[] = rows.map((r) => ({
    id: r.id as string,
    type: r.type as SearchType,
    name: r.name as string,
    entityType: (r.entity_type as string) ?? null,
    registryId: (r.registry_id as string) ?? null,
    schemaId: (r.schema_id as string) ?? null,
    projectId: r.project_id as string,
    folderId: (r.folder_id as string) ?? null,
    createdById: r.created_by_id as string,
    createdAt: iso(r.created_at)!,
    modifiedAt: iso(r.modified_at)!,
    archivedAt: iso(r.archived_at),
    archiveReason: (r.archive_reason as string) ?? null,
  }));
  return { items, total: rows.length ? Number(rows[0]!.total) : 0, limit, offset };
}
