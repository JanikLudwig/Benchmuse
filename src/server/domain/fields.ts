/**
 * The field engine: validates and normalizes user-supplied field values against a schema's
 * field definitions. Pure and synchronous: references that need a database lookup
 * (dropdown options, linked entities) are returned for the caller to verify.
 */

import { isIdOf } from "./ids";

export const FIELD_TYPES = [
  "text",
  "long_text",
  "integer",
  "float",
  "boolean",
  "date",
  "datetime",
  "dropdown",
  "json",
  "entity_link",
] as const;

export type FieldType = (typeof FIELD_TYPES)[number];

export interface FieldDefinition {
  id: string;
  /** Stable API name, e.g. `concentration_ng_ul`. Unique within a schema. */
  name: string;
  displayName: string;
  type: FieldType;
  isRequired: boolean;
  isMulti: boolean;
  /** For `dropdown` fields: the dropdown whose options are allowed. */
  dropdownId?: string | null;
  /** For `entity_link` fields: restrict links to entities of this schema (null = any entity). */
  targetSchemaId?: string | null;
  archivedAt?: Date | null;
}

export type ScalarValue = string | number | boolean | Record<string, unknown> | unknown[];
export type FieldValue = ScalarValue | ScalarValue[] | null;
export type FieldValues = Record<string, FieldValue>;

export type FieldReference =
  | { fieldName: string; kind: "dropdown_option"; id: string; dropdownId: string }
  | { fieldName: string; kind: "entity"; id: string; targetSchemaId: string | null };

export interface FieldError {
  field: string;
  message: string;
}

export type ValidationResult =
  | { ok: true; values: FieldValues; references: FieldReference[] }
  | { ok: false; errors: FieldError[] };

export const FIELD_NAME_PATTERN = /^[a-z][a-z0-9_]{0,62}$/;

export function validateFieldDefinition(def: Omit<FieldDefinition, "id">): FieldError[] {
  const errors: FieldError[] = [];
  const field = def.name || "(unnamed)";
  if (!FIELD_NAME_PATTERN.test(def.name)) {
    errors.push({ field, message: "name must be lowercase snake_case, start with a letter, and be at most 63 characters" });
  }
  if (!def.displayName.trim()) errors.push({ field, message: "displayName is required" });
  if (!FIELD_TYPES.includes(def.type)) errors.push({ field, message: `unknown field type '${def.type}'` });
  if (def.type === "dropdown" && !isIdOf("dropdown", def.dropdownId)) {
    errors.push({ field, message: "dropdown fields need a dropdownId" });
  }
  if (def.type !== "dropdown" && def.dropdownId) {
    errors.push({ field, message: "dropdownId is only valid on dropdown fields" });
  }
  if (def.type !== "entity_link" && def.targetSchemaId) {
    errors.push({ field, message: "targetSchemaId is only valid on entity_link fields" });
  }
  if (def.type === "entity_link" && def.targetSchemaId && !isIdOf("schema", def.targetSchemaId)) {
    errors.push({ field, message: "targetSchemaId must be a schema ID" });
  }
  return errors;
}

type Coerced = { ok: true; value: ScalarValue; reference?: FieldReference } | { ok: false; message: string };

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
// Datetimes must carry an explicit offset so they are unambiguous across lab sites.
const ISO_DATETIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2})$/;

function isValidCalendarDate(value: string): boolean {
  const m = ISO_DATE.exec(value);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const date = new Date(Date.UTC(y, mo - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === mo - 1 && date.getUTCDate() === d;
}

function parseNumber(raw: unknown): number | null {
  if (typeof raw === "number") return Number.isFinite(raw) ? raw : null;
  if (typeof raw === "string" && raw.trim() !== "" && !Number.isNaN(Number(raw.trim()))) {
    const n = Number(raw.trim());
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function coerceScalar(def: FieldDefinition, raw: unknown): Coerced {
  switch (def.type) {
    case "text":
    case "long_text": {
      if (typeof raw !== "string") return { ok: false, message: "expected a string" };
      const max = def.type === "text" ? 1_000 : 100_000;
      if (raw.length > max) return { ok: false, message: `must be at most ${max} characters` };
      return { ok: true, value: raw };
    }
    case "integer": {
      const n = parseNumber(raw);
      if (n === null || !Number.isSafeInteger(n)) return { ok: false, message: "expected an integer" };
      return { ok: true, value: n };
    }
    case "float": {
      const n = parseNumber(raw);
      if (n === null) return { ok: false, message: "expected a number" };
      return { ok: true, value: n };
    }
    case "boolean": {
      if (typeof raw === "boolean") return { ok: true, value: raw };
      if (raw === "true" || raw === "false") return { ok: true, value: raw === "true" };
      return { ok: false, message: "expected true or false" };
    }
    case "date": {
      if (typeof raw !== "string" || !isValidCalendarDate(raw)) {
        return { ok: false, message: "expected a date as YYYY-MM-DD" };
      }
      return { ok: true, value: raw };
    }
    case "datetime": {
      if (typeof raw !== "string" || !ISO_DATETIME.test(raw) || Number.isNaN(Date.parse(raw))) {
        return { ok: false, message: "expected an ISO 8601 datetime with timezone, e.g. 2026-01-31T14:00:00Z" };
      }
      return { ok: true, value: new Date(raw).toISOString() };
    }
    case "dropdown": {
      if (!isIdOf("dropdownOption", raw)) return { ok: false, message: "expected a dropdown option ID" };
      return {
        ok: true,
        value: raw,
        reference: { fieldName: def.name, kind: "dropdown_option", id: raw, dropdownId: def.dropdownId! },
      };
    }
    case "json": {
      if (raw === undefined) return { ok: false, message: "expected JSON" };
      try {
        const size = JSON.stringify(raw).length;
        if (size > 100_000) return { ok: false, message: "JSON value must be at most 100 kB" };
      } catch {
        return { ok: false, message: "expected JSON-serializable value" };
      }
      return { ok: true, value: raw as ScalarValue };
    }
    case "entity_link": {
      if (!isIdOf("entity", raw)) return { ok: false, message: "expected an entity ID" };
      return {
        ok: true,
        value: raw,
        reference: { fieldName: def.name, kind: "entity", id: raw, targetSchemaId: def.targetSchemaId ?? null },
      };
    }
  }
}

function isEmpty(raw: unknown): boolean {
  return raw === null || raw === undefined || raw === "" || (Array.isArray(raw) && raw.length === 0);
}

/**
 * Validate `input` against `fields`.
 *
 * - `create`: every required field must be present and non-empty; absent optional fields become null.
 * - `update`: only keys present in `input` are validated and returned (a partial patch); setting a
 *   required field to empty is an error.
 */
export function validateFieldValues(
  fields: readonly FieldDefinition[],
  input: Record<string, unknown>,
  mode: "create" | "update",
): ValidationResult {
  const errors: FieldError[] = [];
  const values: FieldValues = {};
  const references: FieldReference[] = [];
  const byName = new Map(fields.map((f) => [f.name, f]));

  for (const key of Object.keys(input)) {
    const def = byName.get(key);
    if (!def) errors.push({ field: key, message: "unknown field" });
    else if (def.archivedAt && !isEmpty(input[key])) errors.push({ field: key, message: "field is archived" });
  }

  for (const def of fields) {
    if (def.archivedAt) continue;
    const present = Object.hasOwn(input, def.name);
    if (mode === "update" && !present) continue;
    const raw = input[def.name];

    if (isEmpty(raw)) {
      if (def.isRequired) errors.push({ field: def.name, message: "is required" });
      else values[def.name] = null;
      continue;
    }

    if (def.isMulti) {
      if (!Array.isArray(raw)) {
        errors.push({ field: def.name, message: "expected a list of values" });
        continue;
      }
      const out: ScalarValue[] = [];
      const seen = new Set<string>();
      raw.forEach((item, i) => {
        const r = coerceScalar(def, item);
        if (!r.ok) {
          errors.push({ field: `${def.name}[${i}]`, message: r.message });
          return;
        }
        const key = JSON.stringify(r.value);
        if (seen.has(key)) return; // multi-values behave like sets
        seen.add(key);
        out.push(r.value);
        if (r.reference) references.push(r.reference);
      });
      values[def.name] = out;
    } else {
      if (Array.isArray(raw) && def.type !== "json") {
        errors.push({ field: def.name, message: "expected a single value, not a list" });
        continue;
      }
      const r = coerceScalar(def, raw);
      if (!r.ok) errors.push({ field: def.name, message: r.message });
      else {
        values[def.name] = r.value;
        if (r.reference) references.push(r.reference);
      }
    }
  }

  return errors.length ? { ok: false, errors } : { ok: true, values, references };
}
