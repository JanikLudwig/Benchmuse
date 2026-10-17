import { getContext } from "@/server/api/http";
import { readFileBytes } from "@/server/services/files";
import { AppError } from "@/server/services/errors";

/** Download the stored bytes. Returns the raw file, not JSON, so it streams to the browser. */
export async function GET(_req: Request, { params }: { params: Promise<Record<string, string>> }) {
  try {
    const [{ db }, resolved] = await Promise.all([getContext(), params]);
    const { file, bytes } = await readFileBytes(db, resolved.id!);
    return new Response(bytes as BodyInit, {
      headers: {
        "content-type": file.contentType,
        "content-length": String(bytes.length),
        "content-disposition": `attachment; filename="${file.name.replace(/"/g, "")}"`,
        // Content is immutable for a given id, so it can be cached hard by the browser.
        "cache-control": "private, max-age=31536000, immutable",
      },
    });
  } catch (error) {
    const status = error instanceof AppError ? error.status : 500;
    const message = error instanceof AppError ? error.message : "Could not read the file";
    return new Response(message, { status });
  }
}
