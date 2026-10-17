/**
 * Authentication: password hashing, browser sessions and API keys.
 *
 * Passwords are hashed with scrypt, which is memory-hard and part of Node's standard library,
 * so there is no native dependency to build. Session and API tokens are random 256-bit values;
 * only their SHA-256 hashes are stored, so a database leak does not hand over live credentials.
 */

import { createHash, randomBytes, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import { and, eq, gt, isNull, lt, or } from "drizzle-orm";
import type { Db } from "../db/client";
import { apiKeys, sessions, users, type UserRole } from "../db/schema";
import { newId } from "../domain/ids";
import { AppError, NotFoundError, ValidationError } from "./errors";

const scrypt = promisify(scryptCallback) as (password: string, salt: Buffer, keylen: number) => Promise<Buffer>;

const SCRYPT_KEY_LENGTH = 64;
const SESSION_DAYS = 30;
const MIN_PASSWORD_LENGTH = 10;

export class AuthError extends AppError {
  constructor(message = "Not signed in") {
    super(401, "unauthenticated", message);
  }
}

export class ForbiddenError extends AppError {
  constructor(message = "You do not have access to this") {
    super(403, "forbidden", message);
  }
}

// ---------------------------------------------------------------------------------------------
// Passwords

export async function hashPassword(password: string): Promise<string> {
  if (password.length < MIN_PASSWORD_LENGTH) {
    throw new ValidationError(`Passwords must be at least ${MIN_PASSWORD_LENGTH} characters`);
  }
  if (password.length > 1024) throw new ValidationError("Password is too long");
  const salt = randomBytes(16);
  const derived = await scrypt(password, salt, SCRYPT_KEY_LENGTH);
  return `scrypt$${salt.toString("hex")}$${derived.toString("hex")}`;
}

export async function verifyPassword(password: string, stored: string | null): Promise<boolean> {
  if (!stored) return false;
  const [scheme, saltHex, hashHex] = stored.split("$");
  if (scheme !== "scrypt" || !saltHex || !hashHex) return false;
  const derived = await scrypt(password, Buffer.from(saltHex, "hex"), SCRYPT_KEY_LENGTH);
  const expected = Buffer.from(hashHex, "hex");
  // Lengths must match before timingSafeEqual, which throws on a mismatch.
  return derived.length === expected.length && timingSafeEqual(derived, expected);
}

// ---------------------------------------------------------------------------------------------
// Tokens

const hashToken = (token: string): string => createHash("sha256").update(token).digest("hex");

function newToken(): string {
  return randomBytes(32).toString("base64url");
}

export const SESSION_COOKIE = "benchmuse_session";

export interface SignInResult {
  token: string;
  expiresAt: Date;
  user: typeof users.$inferSelect;
}

/**
 * Check credentials and open a session.
 *
 * The same error is returned whether the account is unknown or the password is wrong, so the
 * response does not reveal which accounts exist.
 */
export async function signIn(
  db: Db,
  input: { handleOrEmail: string; password: string; userAgent?: string },
): Promise<SignInResult> {
  const identifier = input.handleOrEmail.trim().toLowerCase();
  const [user] = await db
    .select()
    .from(users)
    .where(or(eq(users.handle, identifier), eq(users.email, identifier)));

  const ok = user ? await verifyPassword(input.password, user.passwordHash) : await notFoundDelay(input.password);
  if (!user || !ok) throw new AuthError("That username or password is not right");
  if (user.disabledAt) throw new ForbiddenError("This account has been disabled");

  const token = newToken();
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000);
  await db.insert(sessions).values({
    id: newId("session"),
    userId: user.id,
    tokenHash: hashToken(token),
    expiresAt,
    userAgent: input.userAgent?.slice(0, 500) ?? null,
  });
  await db.update(users).set({ lastSeenAt: new Date() }).where(eq(users.id, user.id));
  return { token, expiresAt, user };
}

/** Spend the same work on an unknown account as on a real one, so timing does not leak. */
async function notFoundDelay(password: string): Promise<boolean> {
  await scrypt(password, randomBytes(16), SCRYPT_KEY_LENGTH);
  return false;
}

export async function signOut(db: Db, token: string): Promise<void> {
  await db.delete(sessions).where(eq(sessions.tokenHash, hashToken(token)));
}

export interface Authenticated {
  user: typeof users.$inferSelect;
  via: "session" | "api-key";
}

/** Resolve a session cookie to its user, refusing expired sessions. */
export async function userForSession(db: Db, token: string): Promise<Authenticated | null> {
  const hash = hashToken(token);
  const [row] = await db
    .select({ session: sessions, user: users })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(and(eq(sessions.tokenHash, hash), gt(sessions.expiresAt, new Date())));
  if (!row || row.user.disabledAt) return null;
  // Touch the session so idle ones can be cleaned up later.
  await db.update(sessions).set({ lastUsedAt: new Date() }).where(eq(sessions.id, row.session.id));
  return { user: row.user, via: "session" };
}

export async function userForApiKey(db: Db, token: string): Promise<Authenticated | null> {
  const hash = hashToken(token);
  const [row] = await db
    .select({ key: apiKeys, user: users })
    .from(apiKeys)
    .innerJoin(users, eq(users.id, apiKeys.userId))
    .where(and(eq(apiKeys.tokenHash, hash), isNull(apiKeys.revokedAt)));
  if (!row || row.user.disabledAt) return null;
  if (row.key.expiresAt && row.key.expiresAt < new Date()) return null;
  await db.update(apiKeys).set({ lastUsedAt: new Date() }).where(eq(apiKeys.id, row.key.id));
  return { user: row.user, via: "api-key" };
}

// ---------------------------------------------------------------------------------------------
// Accounts

export interface CreateUserInput {
  handle: string;
  name: string;
  email: string;
  password?: string;
  role?: UserRole;
}

const HANDLE = /^[a-z0-9][a-z0-9-]{1,38}$/;
const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

export async function createUser(db: Db, input: CreateUserInput) {
  const handle = input.handle.trim().toLowerCase();
  const email = input.email.trim().toLowerCase();
  if (!HANDLE.test(handle)) throw new ValidationError("Handle must be 2-39 lowercase letters, digits or dashes");
  if (!EMAIL.test(email)) throw new ValidationError("That does not look like an email address");
  if (!input.name.trim()) throw new ValidationError("Name is required");

  const passwordHash = input.password ? await hashPassword(input.password) : null;
  const [created] = await db
    .insert(users)
    .values({
      id: newId("user"),
      handle,
      name: input.name.trim(),
      email,
      passwordHash,
      role: input.role ?? "member",
    })
    .onConflictDoNothing()
    .returning();
  if (!created) throw new ValidationError("That handle or email is already taken");
  return created;
}

export async function setPassword(db: Db, userId: string, password: string): Promise<void> {
  const hash = await hashPassword(password);
  const result = await db.update(users).set({ passwordHash: hash }).where(eq(users.id, userId)).returning();
  if (!result.length) throw new NotFoundError("User", userId);
  // Changing a password ends every other session, as a password change should.
  await db.delete(sessions).where(eq(sessions.userId, userId));
}

export async function listUsers(db: Db) {
  return db.select().from(users).orderBy(users.name);
}

export async function countUsers(db: Db): Promise<number> {
  const rows = await db.select({ id: users.id }).from(users);
  return rows.length;
}

// ---------------------------------------------------------------------------------------------
// API keys

export async function createApiKey(db: Db, userId: string, name: string, expiresAt?: Date) {
  if (!name.trim()) throw new ValidationError("Give the key a name so you can recognise it later");
  const token = `bm_${newToken()}`;
  const [row] = await db
    .insert(apiKeys)
    .values({
      id: newId("apiKey"),
      userId,
      name: name.trim().slice(0, 100),
      tokenHash: hashToken(token),
      prefix: token.slice(0, 11),
      expiresAt: expiresAt ?? null,
    })
    .returning();
  // The raw token is returned once and never stored.
  return { key: row!, token };
}

export async function listApiKeys(db: Db, userId: string) {
  return db.select().from(apiKeys).where(eq(apiKeys.userId, userId));
}

export async function revokeApiKey(db: Db, userId: string, keyId: string): Promise<void> {
  await db
    .update(apiKeys)
    .set({ revokedAt: new Date() })
    .where(and(eq(apiKeys.id, keyId), eq(apiKeys.userId, userId)));
}

/** Delete sessions that have expired. Safe to call on a schedule. */
export async function pruneSessions(db: Db): Promise<void> {
  await db.delete(sessions).where(lt(sessions.expiresAt, new Date()));
}

export function requireRole(user: { role: UserRole }, ...allowed: UserRole[]): void {
  if (!allowed.includes(user.role)) throw new ForbiddenError(`This action needs the ${allowed.join(" or ")} role`);
}

/** Viewers may read but not change anything. */
export function requireWriteAccess(user: { role: UserRole }): void {
  if (user.role === "viewer") throw new ForbiddenError("Your account has read-only access");
}
