/**
 * Content-addressed blob storage for uploaded files.
 *
 * The default implementation writes to a local directory, which is all a single-server
 * deployment needs. The interface is small on purpose so an S3-backed store can replace it
 * without touching callers.
 */

import { createHash } from "node:crypto";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

export interface BlobStore {
  /** Store bytes and return their SHA-256. Storing identical bytes twice is a no-op. */
  put(bytes: Uint8Array): Promise<string>;
  get(sha256: string): Promise<Uint8Array>;
  exists(sha256: string): Promise<boolean>;
  delete(sha256: string): Promise<void>;
}

export function sha256Of(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

const SHA_PATTERN = /^[a-f0-9]{64}$/;

export class LocalBlobStore implements BlobStore {
  constructor(private readonly root: string) {}

  /** Two-level fan-out keeps directory listings small on large instances. */
  private pathFor(sha256: string): string {
    if (!SHA_PATTERN.test(sha256)) throw new Error("Invalid blob digest");
    return path.join(this.root, sha256.slice(0, 2), sha256.slice(2, 4), sha256);
  }

  async put(bytes: Uint8Array): Promise<string> {
    const digest = sha256Of(bytes);
    const target = this.pathFor(digest);
    if (await this.exists(digest)) return digest;
    await mkdir(path.dirname(target), { recursive: true });
    // Write to a temporary name first so a crash cannot leave a half-written blob in place.
    const temp = `${target}.${process.pid}.tmp`;
    await writeFile(temp, bytes);
    const { rename } = await import("node:fs/promises");
    await rename(temp, target);
    return digest;
  }

  async get(sha256: string): Promise<Uint8Array> {
    return new Uint8Array(await readFile(this.pathFor(sha256)));
  }

  async exists(sha256: string): Promise<boolean> {
    try {
      await stat(this.pathFor(sha256));
      return true;
    } catch {
      return false;
    }
  }

  async delete(sha256: string): Promise<void> {
    await rm(this.pathFor(sha256), { force: true });
  }
}

let store: BlobStore | undefined;

export function getBlobStore(): BlobStore {
  store ??= new LocalBlobStore(process.env.BENCHMUSE_BLOB_DIR ?? path.join(process.cwd(), ".data/blobs"));
  return store;
}

/** Used by tests to swap in an in-memory store. */
export function setBlobStore(next: BlobStore | undefined): void {
  store = next;
}

export class MemoryBlobStore implements BlobStore {
  private readonly blobs = new Map<string, Uint8Array>();
  async put(bytes: Uint8Array): Promise<string> {
    const digest = sha256Of(bytes);
    this.blobs.set(digest, bytes);
    return digest;
  }
  async get(sha256: string): Promise<Uint8Array> {
    const found = this.blobs.get(sha256);
    if (!found) throw new Error(`blob ${sha256} not found`);
    return found;
  }
  async exists(sha256: string): Promise<boolean> {
    return this.blobs.has(sha256);
  }
  async delete(sha256: string): Promise<void> {
    this.blobs.delete(sha256);
  }
}
