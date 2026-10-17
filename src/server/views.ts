/** Read-model helpers shared by server-rendered pages. */
import { inArray } from "drizzle-orm";
import type { Db } from "./db/client";
import { users } from "./db/schema";
import type { SchemaWithFields } from "./services/schemas";
import type { DropdownDef } from "@/components/FieldInputs";

export async function getUserNames(db: Db, ids: string[]): Promise<Record<string, string>> {
  const unique = [...new Set(ids)];
  if (!unique.length) return {};
  const rows = await db.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, unique));
  return Object.fromEntries(rows.map((r) => [r.id, r.name]));
}

/** Every ID-valued field value, for resolving display names of linked entities. */
export function linkedIds(values: Record<string, unknown>): string[] {
  return Object.values(values).flatMap((v) => (Array.isArray(v) ? v : [v])).filter((v): v is string => typeof v === "string");
}

/** Labels for audit keys (`fields.<name>`) and names for dropdown option IDs. */
export function auditLabels(schema: SchemaWithFields | null, dropdowns: DropdownDef[]) {
  const fieldLabels = Object.fromEntries((schema?.fields ?? []).map((f) => [`fields.${f.name}`, f.displayName]));
  const optionNames = Object.fromEntries(dropdowns.flatMap((d) => d.options.map((o) => [o.id, o.name])));
  return { fieldLabels, optionNames };
}
