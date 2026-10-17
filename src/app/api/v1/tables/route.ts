import { z } from "zod";
import { parseBody, route, searchParams } from "@/server/api/http";
import { createTable, evaluateTable, listTablesForEntry } from "@/server/services/notebookTables";
import { ValidationError } from "@/server/services/errors";

const columnBody = z.object({
  id: z.string().optional(),
  name: z.string().max(100),
  type: z.enum(["text", "number", "date", "checkbox", "select", "entity", "formula"]).optional(),
  unit: z.string().max(20).optional(),
  width: z.number().int().optional(),
  options: z.array(z.string().max(100)).max(100).optional(),
  decimals: z.number().int().min(0).max(10).optional(),
});

const createBody = z.object({
  entryId: z.string(),
  name: z.string().max(200).optional(),
  columns: z.array(columnBody).max(60).optional(),
  rows: z.array(z.array(z.string().max(10000))).max(2000).optional(),
});

export const GET = route(async ({ req, ctx }) => {
  const entryId = searchParams(req).get("entryId");
  if (!entryId) throw new ValidationError("entryId is required");
  return { items: await listTablesForEntry(ctx.db, entryId) };
});

// Returns the evaluated table, so create, read and update all hand back the same shape.
export const POST = route(
  async ({ req, ctx }) => evaluateTable(await createTable(ctx.db, ctx.actor, await parseBody(req, createBody))),
  { status: 201 },
);
