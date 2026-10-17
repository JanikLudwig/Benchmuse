import { eq } from "drizzle-orm";
import type { Db } from "../db/client";
import { users } from "../db/schema";
import { newId } from "../domain/ids";
import { NotFoundError, ValidationError } from "./errors";

const HANDLE = /^[a-z0-9][a-z0-9-]{1,38}$/;

export async function ensureUser(db: Db, input: { handle: string; name: string; email: string }) {
  if (!HANDLE.test(input.handle)) throw new ValidationError("handle must be 2-39 lowercase letters, digits or dashes");
  const [existing] = await db.select().from(users).where(eq(users.handle, input.handle));
  if (existing) return existing;
  const [created] = await db
    .insert(users)
    .values({ id: newId("user"), handle: input.handle, name: input.name.trim(), email: input.email.trim().toLowerCase() })
    .onConflictDoNothing()
    .returning();
  // Lost a race with a concurrent ensureUser: read the winner.
  return created ?? (await getUserByHandle(db, input.handle));
}

export async function getUserByHandle(db: Db, handle: string) {
  const [user] = await db.select().from(users).where(eq(users.handle, handle));
  if (!user) throw new NotFoundError("User", handle);
  return user;
}

export async function listUsers(db: Db) {
  return db.select().from(users);
}
