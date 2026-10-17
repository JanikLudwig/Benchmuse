/**
 * Uploaded files: storing bytes, recording metadata, and recognising what was uploaded.
 */

import { and, desc, eq, isNull } from "drizzle-orm";
import { isAb1 } from "@/bio/formats/ab1";
import { isFasta } from "@/bio/formats/fasta";
import { isGenBank } from "@/bio/formats/genbank";
import type { Db } from "../db/client";
import { files } from "../db/schema";
import { newId } from "../domain/ids";
import { getBlobStore, sha256Of } from "../storage/blobs";
import { recordAudit, type Actor } from "./audit";
import { NotFoundError, ValidationError } from "./errors";
import { getWritableFolder } from "./projects";

export const MAX_UPLOAD_BYTES = 64 * 1024 * 1024;

export type DetectedFormat = "genbank" | "fasta" | "ab1" | "csv" | "text" | "binary";

/** Work out what a file is from its bytes first and its name second. */
export function detectFormat(bytes: Uint8Array, filename: string): DetectedFormat {
  if (isAb1(bytes)) return "ab1";
  const head = new TextDecoder("utf-8", { fatal: false }).decode(bytes.slice(0, 8192));
  if (isGenBank(head)) return "genbank";
  if (isFasta(head)) return "fasta";
  const lower = filename.toLowerCase();
  if (/\.(gb|gbk|genbank|ape)$/.test(lower)) return "genbank";
  if (/\.(fa|fasta|fna|ffn|faa|frn|seq)$/.test(lower)) return "fasta";
  if (/\.(ab1|abi|fsa)$/.test(lower)) return "ab1";
  if (/\.(csv|tsv)$/.test(lower)) return "csv";
  // Treat it as text only if it decodes without replacement characters.
  return head.includes("�") ? "binary" : "text";
}

export interface UploadInput {
  name: string;
  contentType?: string;
  bytes: Uint8Array;
  folderId?: string | null;
}

export async function uploadFile(db: Db, actor: Actor, input: UploadInput) {
  const name = input.name.trim().slice(0, 255);
  if (!name) throw new ValidationError("File name is required");
  if (!input.bytes.length) throw new ValidationError("File is empty");
  if (input.bytes.length > MAX_UPLOAD_BYTES) {
    throw new ValidationError(`Files are limited to ${Math.floor(MAX_UPLOAD_BYTES / 1024 / 1024)} MB`);
  }
  if (input.folderId) await getWritableFolder(db, input.folderId);

  const digest = await getBlobStore().put(input.bytes);
  const detected = detectFormat(input.bytes, name);

  return db.transaction(async (tx) => {
    const [row] = await tx
      .insert(files)
      .values({
        id: newId("file"),
        name,
        contentType: input.contentType?.slice(0, 200) || contentTypeFor(detected),
        sizeBytes: input.bytes.length,
        sha256: digest,
        folderId: input.folderId ?? null,
        detectedFormat: detected,
        createdById: actor.id,
      })
      .returning();
    await recordAudit(tx, actor, row!.id, "create", { name: { from: null, to: name } });
    return row!;
  });
}

function contentTypeFor(format: DetectedFormat): string {
  switch (format) {
    case "genbank": return "chemical/seq-na-genbank";
    case "fasta": return "application/x-fasta";
    case "ab1": return "application/octet-stream";
    case "csv": return "text/csv";
    case "text": return "text/plain";
    default: return "application/octet-stream";
  }
}

export async function getFile(db: Db, id: string) {
  const [row] = await db.select().from(files).where(eq(files.id, id));
  if (!row) throw new NotFoundError("File", id);
  return row;
}

export async function readFileBytes(db: Db, id: string): Promise<{ file: typeof files.$inferSelect; bytes: Uint8Array }> {
  const file = await getFile(db, id);
  try {
    return { file, bytes: await getBlobStore().get(file.sha256) };
  } catch {
    throw new NotFoundError("File content for", id);
  }
}

export async function listFiles(db: Db, opts: { folderId?: string; limit?: number } = {}) {
  return db
    .select()
    .from(files)
    .where(and(isNull(files.archivedAt), opts.folderId ? eq(files.folderId, opts.folderId) : undefined))
    .orderBy(desc(files.createdAt))
    .limit(Math.min(opts.limit ?? 100, 500));
}

/** Verify stored bytes still match their digest, for an integrity check. */
export async function verifyFile(db: Db, id: string): Promise<boolean> {
  const { file, bytes } = await readFileBytes(db, id);
  return sha256Of(bytes) === file.sha256;
}
