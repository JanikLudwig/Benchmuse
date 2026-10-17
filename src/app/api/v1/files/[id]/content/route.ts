import { getContext } from "@/server/api/http";
import { readFileBytes } from "@/server/services/files";
import { AppError } from "@/server/services/errors";

/**
 * Image types that are safe to render inline from our own origin.
 *
 * SVG is deliberately absent: it can carry script, and serving it inline would run that script
 * with our origin's privileges. SVG uploads are still downloadable, just never displayed.
 */
const INLINE_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp", "image/avif"]);

/** Download the stored bytes. Returns the raw file, not JSON, so it streams to the browser. */
export async function GET(_req: Request, { params }: { params: Promise<Record<string, string>> }) {
  try {
    const [{ db }, resolved] = await Promise.all([getContext(), params]);
    const { file, bytes } = await readFileBytes(db, resolved.id!);
    const inline = INLINE_IMAGE_TYPES.has(file.contentType.toLowerCase());
    return new Response(bytes as BodyInit, {
      headers: {
        "content-type": inline ? file.contentType : "application/octet-stream",
        "content-length": String(bytes.length),
        "content-disposition": `${inline ? "inline" : "attachment"}; filename="${file.name.replace(/[^\x20-\x7e]|"/g, "")}"`,
        // Content is immutable for a given id, so it can be cached hard by the browser.
        "cache-control": "private, max-age=31536000, immutable",
        // Belt and braces: never let a response be sniffed into something executable.
        "x-content-type-options": "nosniff",
      },
    });
  } catch (error) {
    const status = error instanceof AppError ? error.status : 500;
    const message = error instanceof AppError ? error.message : "Could not read the file";
    return new Response(message, { status });
  }
}
