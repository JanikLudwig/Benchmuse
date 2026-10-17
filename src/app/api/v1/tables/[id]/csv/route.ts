import { getContext } from "@/server/api/http";
import { AppError } from "@/server/services/errors";
import { getEvaluatedTable, tableToCsv } from "@/server/services/notebookTables";

/** Download a table as CSV, with formulas replaced by their computed values. */
export async function GET(_req: Request, { params }: { params: Promise<Record<string, string>> }) {
  try {
    const [{ db }, resolved] = await Promise.all([getContext(), params]);
    const table = await getEvaluatedTable(db, resolved.id!);
    const safeName = table.name.replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 80) || "table";
    return new Response(tableToCsv(table), {
      headers: {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": `attachment; filename="${safeName}.csv"`,
      },
    });
  } catch (error) {
    const status = error instanceof AppError ? error.status : 500;
    return new Response(error instanceof AppError ? error.message : "Export failed", { status });
  }
}
