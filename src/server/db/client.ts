import { mkdirSync } from "node:fs";
import path from "node:path";
import type { ExtractTablesWithRelations } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import * as schema from "./schema";

/** Any Drizzle Postgres handle (PGlite, node-postgres, or a transaction on either). */
export type Db = PgDatabase<PgQueryResultHKT, typeof schema, ExtractTablesWithRelations<typeof schema>>;

const MIGRATIONS_FOLDER = path.join(process.cwd(), "src/server/db/migrations");

/** In-process Postgres (WASM). `dataDir` undefined = in-memory, used by tests. */
export async function createPgliteDb(dataDir?: string): Promise<Db> {
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const { migrate } = await import("drizzle-orm/pglite/migrator");
  if (dataDir) mkdirSync(dataDir, { recursive: true });
  const client = new PGlite(dataDir);
  const db = drizzle(client, { schema });
  await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
  return db as unknown as Db;
}

async function createNodePgDb(url: string): Promise<Db> {
  const { Pool } = await import("pg");
  const { drizzle } = await import("drizzle-orm/node-postgres");
  const { migrate } = await import("drizzle-orm/node-postgres/migrator");
  const db = drizzle(new Pool({ connectionString: url }), { schema });
  await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
  return db as unknown as Db;
}

// Survive Next.js dev-server module reloads: one database handle per process.
const globalForDb = globalThis as unknown as { benchmuseDb?: Promise<Db> };

export function getDb(): Promise<Db> {
  globalForDb.benchmuseDb ??= process.env.DATABASE_URL
    ? createNodePgDb(process.env.DATABASE_URL)
    : createPgliteDb(process.env.PGLITE_DIR ?? path.join(process.cwd(), ".data/pglite"));
  return globalForDb.benchmuseDb;
}
