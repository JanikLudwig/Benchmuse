import { route, searchParams } from "@/server/api/http";
import { ValidationError } from "@/server/services/errors";
import { listFiles, MAX_UPLOAD_BYTES, uploadFile } from "@/server/services/files";

export const GET = route(async ({ req, ctx }) => {
  const p = searchParams(req);
  return { items: await listFiles(ctx.db, { folderId: p.get("folderId") ?? undefined }) };
});

/** Multipart upload: one or more `file` parts, optionally a `folderId` field. */
export const POST = route(
  async ({ req, ctx }) => {
    const contentType = req.headers.get("content-type") ?? "";
    if (!contentType.includes("multipart/form-data")) {
      throw new ValidationError("Upload files as multipart/form-data");
    }
    const form = await req.formData();
    const folderId = (form.get("folderId") as string | null)?.trim() || null;
    const uploads = form.getAll("file").filter((f): f is File => f instanceof File);
    if (!uploads.length) throw new ValidationError("No file was included in the upload");
    if (uploads.length > 50) throw new ValidationError("At most 50 files per upload");

    const items = [];
    for (const upload of uploads) {
      if (upload.size > MAX_UPLOAD_BYTES) throw new ValidationError(`${upload.name} is larger than the ${MAX_UPLOAD_BYTES / 1024 / 1024} MB limit`);
      items.push(
        await uploadFile(ctx.db, ctx.actor, {
          name: upload.name,
          contentType: upload.type,
          bytes: new Uint8Array(await upload.arrayBuffer()),
          folderId,
        }),
      );
    }
    return { items };
  },
  { status: 201 },
);
