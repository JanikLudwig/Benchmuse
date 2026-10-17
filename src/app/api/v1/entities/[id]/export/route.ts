import { getContext } from "@/server/api/http";
import { AppError } from "@/server/services/errors";
import { exportEntity } from "@/server/services/importing";

/** Download an entity as GenBank or FASTA. */
export async function GET(req: Request, { params }: { params: Promise<Record<string, string>> }) {
  try {
    const [{ db }, resolved] = await Promise.all([getContext(), params]);
    const requested = new URL(req.url).searchParams.get("format");
    const format = requested === "fasta" ? "fasta" : "genbank";
    const { filename, contentType, body } = await exportEntity(db, resolved.id!, format);
    return new Response(body, {
      headers: {
        "content-type": `${contentType}; charset=utf-8`,
        "content-disposition": `attachment; filename="${filename}"`,
      },
    });
  } catch (error) {
    const status = error instanceof AppError ? error.status : 500;
    return new Response(error instanceof AppError ? error.message : "Export failed", { status });
  }
}
