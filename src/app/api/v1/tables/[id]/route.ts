import { z } from "zod";
import { parseBody, route } from "@/server/api/http";
import { deleteTable, getEvaluatedTable, updateTable } from "@/server/services/notebookTables";

const updateBody = z.object({
  name: z.string().max(200).optional(),
  columns: z
    .array(
      z.object({
        id: z.string().optional(),
        name: z.string().max(100),
        type: z.enum(["text", "number", "date", "checkbox", "select", "entity", "formula"]).optional(),
        unit: z.string().max(20).optional(),
        width: z.number().int().optional(),
        options: z.array(z.string().max(100)).max(100).optional(),
        decimals: z.number().int().min(0).max(10).optional(),
      }),
    )
    .max(60)
    .optional(),
  rows: z.array(z.array(z.string().max(10000))).max(2000).optional(),
});

export const GET = route(async ({ ctx, params }) => getEvaluatedTable(ctx.db, params.id!));

export const PUT = route(async ({ req, ctx, params }) => updateTable(ctx.db, ctx.actor, params.id!, await parseBody(req, updateBody)));

export const DELETE = route(async ({ ctx, params }) => {
  await deleteTable(ctx.db, ctx.actor, params.id!);
  return { deleted: true };
});
