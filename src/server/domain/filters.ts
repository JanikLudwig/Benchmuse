/**
 * List/search filter grammar. Every list view is `GET /api/v1/search` (or a typed list endpoint)
 * plus a filter expression that round-trips through the URL.
 *
 *   filter = clause (";" clause)*
 *   clause = property ":" OPERATOR [ ":" value ("," value)* ]
 *   sort   = property ":" ("asc" | "desc") (";" ...)*
 *
 * Values are percent-encoded individually, so `:`, `;` and `,` inside values are safe.
 *
 *   type:IS_ONE_OF:entity,entry;archived:IS_FALSE;field.strain:EQ:K-12
 */

export const OPERATORS = [
  "EQ",
  "NEQ",
  "IS_ONE_OF",
  "CONTAINS",
  "GT",
  "GTE",
  "LT",
  "LTE",
  "IS_TRUE",
  "IS_FALSE",
  "IS_EMPTY",
  "IS_NOT_EMPTY",
] as const;

export type Operator = (typeof OPERATORS)[number];

const NULLARY: ReadonlySet<Operator> = new Set(["IS_TRUE", "IS_FALSE", "IS_EMPTY", "IS_NOT_EMPTY"]);
const MULTI: ReadonlySet<Operator> = new Set(["IS_ONE_OF"]);

export interface FilterClause {
  property: string;
  operator: Operator;
  values: string[];
}

export interface SortClause {
  property: string;
  direction: "asc" | "desc";
}

export type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

const PROPERTY = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)?$/;

export function parseFilter(input: string | null | undefined): Parsed<FilterClause[]> {
  if (!input) return { ok: true, value: [] };
  const clauses: FilterClause[] = [];
  for (const raw of input.split(";")) {
    if (!raw) continue;
    const [property, operator, valuePart, ...rest] = raw.split(":");
    if (rest.length) return { ok: false, error: `too many ':' in clause '${raw}' (percent-encode values)` };
    if (!property || !PROPERTY.test(property)) return { ok: false, error: `invalid property in '${raw}'` };
    if (!operator || !(OPERATORS as readonly string[]).includes(operator)) {
      return { ok: false, error: `unknown operator in '${raw}'` };
    }
    const op = operator as Operator;
    let values: string[] = [];
    if (NULLARY.has(op)) {
      if (valuePart !== undefined) return { ok: false, error: `${op} takes no value` };
    } else {
      if (valuePart === undefined || valuePart === "") return { ok: false, error: `${op} needs a value` };
      try {
        values = valuePart.split(",").map((v) => decodeURIComponent(v));
      } catch {
        return { ok: false, error: `malformed percent-encoding in '${raw}'` };
      }
      if (!MULTI.has(op) && values.length !== 1) return { ok: false, error: `${op} takes exactly one value` };
    }
    clauses.push({ property, operator: op, values });
  }
  return { ok: true, value: clauses };
}

export function serializeFilter(clauses: readonly FilterClause[]): string {
  return clauses
    .map((c) => {
      const head = `${c.property}:${c.operator}`;
      return NULLARY.has(c.operator) ? head : `${head}:${c.values.map(encodeURIComponent).join(",")}`;
    })
    .join(";");
}

export function parseSort(input: string | null | undefined): Parsed<SortClause[]> {
  if (!input) return { ok: true, value: [] };
  const out: SortClause[] = [];
  for (const raw of input.split(";")) {
    if (!raw) continue;
    const [property, direction = "asc", ...rest] = raw.split(":");
    if (rest.length || !property || !PROPERTY.test(property) || (direction !== "asc" && direction !== "desc")) {
      return { ok: false, error: `invalid sort '${raw}' (expected property:asc|desc)` };
    }
    out.push({ property, direction });
  }
  return { ok: true, value: out };
}

export function serializeSort(clauses: readonly SortClause[]): string {
  return clauses.map((c) => `${c.property}:${c.direction}`).join(";");
}
