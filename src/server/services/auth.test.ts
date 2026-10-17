import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createPgliteDb, type Db } from "../db/client";
import {
  AuthError,
  ForbiddenError,
  countUsers,
  createApiKey,
  createUser,
  hashPassword,
  listApiKeys,
  pruneSessions,
  requireRole,
  requireWriteAccess,
  revokeApiKey,
  setPassword,
  signIn,
  signOut,
  userForApiKey,
  userForSession,
  verifyPassword,
} from "./auth";
import { ValidationError } from "./errors";
import { sessions } from "../db/schema";
import { eq } from "drizzle-orm";

let db: Db;

beforeAll(async () => {
  db = await createPgliteDb();
});

let counter = 0;
const unique = () => `u${counter++}${Math.random().toString(36).slice(2, 6)}`;

async function makeUser(password = "correct-horse-battery", role: "admin" | "member" | "viewer" = "member") {
  const handle = unique();
  return createUser(db, { handle, name: "Test User", email: `${handle}@example.com`, password, role });
}

describe("passwords", () => {
  it("hashes and verifies", async () => {
    const hash = await hashPassword("correct-horse-battery");
    expect(hash.startsWith("scrypt$")).toBe(true);
    expect(await verifyPassword("correct-horse-battery", hash)).toBe(true);
    expect(await verifyPassword("wrong-password-here", hash)).toBe(false);
  });

  it("salts, so the same password hashes differently each time", async () => {
    const [a, b] = await Promise.all([hashPassword("correct-horse-battery"), hashPassword("correct-horse-battery")]);
    expect(a).not.toBe(b);
    expect(await verifyPassword("correct-horse-battery", a)).toBe(true);
  });

  it("rejects short passwords and malformed hashes", async () => {
    await expect(hashPassword("short")).rejects.toBeInstanceOf(ValidationError);
    expect(await verifyPassword("anything", null)).toBe(false);
    expect(await verifyPassword("anything", "not-a-hash")).toBe(false);
    expect(await verifyPassword("anything", "scrypt$zz$zz")).toBe(false);
  });
});

describe("accounts", () => {
  it("creates a user and counts them", async () => {
    const before = await countUsers(db);
    const user = await makeUser();
    expect(user.role).toBe("member");
    expect(user.passwordHash).toBeTruthy();
    expect(await countUsers(db)).toBe(before + 1);
  });

  it("rejects bad handles, emails and duplicates", async () => {
    await expect(createUser(db, { handle: "Not Valid", name: "x", email: "a@b.co" })).rejects.toThrow(/Handle/);
    await expect(createUser(db, { handle: "okhandle", name: "x", email: "nope" })).rejects.toThrow(/email/);
    const user = await makeUser();
    await expect(createUser(db, { handle: user.handle, name: "x", email: "other@example.com" })).rejects.toThrow(/already taken/);
  });
});

describe("sign in", () => {
  it("opens a session that resolves back to the user", async () => {
    const user = await makeUser();
    const { token, user: signedIn } = await signIn(db, { handleOrEmail: user.handle, password: "correct-horse-battery" });
    expect(signedIn.id).toBe(user.id);
    const resolved = await userForSession(db, token);
    expect(resolved?.user.id).toBe(user.id);
    expect(resolved?.via).toBe("session");
  });

  it("accepts the email address too, case-insensitively", async () => {
    const user = await makeUser();
    const { token } = await signIn(db, { handleOrEmail: user.email.toUpperCase(), password: "correct-horse-battery" });
    expect((await userForSession(db, token))?.user.id).toBe(user.id);
  });

  it("refuses a wrong password, and says the same thing for an unknown account", async () => {
    const user = await makeUser();
    await expect(signIn(db, { handleOrEmail: user.handle, password: "wrong-password" })).rejects.toBeInstanceOf(AuthError);
    await expect(signIn(db, { handleOrEmail: "nobody-here", password: "wrong-password" })).rejects.toThrow(
      /username or password is not right/,
    );
  });

  it("refuses a disabled account", async () => {
    const user = await makeUser();
    const { users: usersTable } = await import("../db/schema");
    await db.update(usersTable).set({ disabledAt: new Date() }).where(eq(usersTable.id, user.id));
    await expect(signIn(db, { handleOrEmail: user.handle, password: "correct-horse-battery" })).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("signs out, invalidating the token", async () => {
    const user = await makeUser();
    const { token } = await signIn(db, { handleOrEmail: user.handle, password: "correct-horse-battery" });
    await signOut(db, token);
    expect(await userForSession(db, token)).toBeNull();
  });

  it("rejects an expired session and prunes it", async () => {
    const user = await makeUser();
    const { token } = await signIn(db, { handleOrEmail: user.handle, password: "correct-horse-battery" });
    const hashed = await db.select().from(sessions).where(eq(sessions.userId, user.id));
    await db.update(sessions).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(sessions.id, hashed[0]!.id));
    expect(await userForSession(db, token)).toBeNull();
    await pruneSessions(db);
    expect(await db.select().from(sessions).where(eq(sessions.id, hashed[0]!.id))).toEqual([]);
  });

  it("never stores the raw token", async () => {
    const user = await makeUser();
    const { token } = await signIn(db, { handleOrEmail: user.handle, password: "correct-horse-battery" });
    const stored = await db.select().from(sessions).where(eq(sessions.userId, user.id));
    expect(stored[0]!.tokenHash).not.toBe(token);
    expect(stored[0]!.tokenHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("ends every session when the password changes", async () => {
    const user = await makeUser();
    const { token } = await signIn(db, { handleOrEmail: user.handle, password: "correct-horse-battery" });
    await setPassword(db, user.id, "a-brand-new-password");
    expect(await userForSession(db, token)).toBeNull();
    const { token: fresh } = await signIn(db, { handleOrEmail: user.handle, password: "a-brand-new-password" });
    expect((await userForSession(db, fresh))?.user.id).toBe(user.id);
  });
});

describe("API keys", () => {
  it("issues a key that authenticates, and shows the token only once", async () => {
    const user = await makeUser();
    const { key, token } = await createApiKey(db, user.id, "instrument upload");
    expect(token.startsWith("bm_")).toBe(true);
    expect(key.prefix).toBe(token.slice(0, 11));

    const resolved = await userForApiKey(db, token);
    expect(resolved?.user.id).toBe(user.id);
    expect(resolved?.via).toBe("api-key");

    const listed = await listApiKeys(db, user.id);
    expect(listed[0]!.tokenHash).not.toBe(token);
  });

  it("stops working once revoked", async () => {
    const user = await makeUser();
    const { key, token } = await createApiKey(db, user.id, "temporary");
    await revokeApiKey(db, user.id, key.id);
    expect(await userForApiKey(db, token)).toBeNull();
  });

  it("stops working once expired", async () => {
    const user = await makeUser();
    const { token } = await createApiKey(db, user.id, "expired", new Date(Date.now() - 1000));
    expect(await userForApiKey(db, token)).toBeNull();
  });

  it("rejects an unknown token", async () => {
    expect(await userForApiKey(db, "bm_nope")).toBeNull();
    expect(await userForSession(db, "nope")).toBeNull();
  });
});

describe("roles", () => {
  it("lets members write but not viewers", () => {
    expect(() => requireWriteAccess({ role: "member" })).not.toThrow();
    expect(() => requireWriteAccess({ role: "admin" })).not.toThrow();
    expect(() => requireWriteAccess({ role: "viewer" })).toThrow(/read-only/);
  });

  it("restricts actions to named roles", () => {
    expect(() => requireRole({ role: "admin" }, "admin")).not.toThrow();
    expect(() => requireRole({ role: "member" }, "admin")).toThrow(/needs the admin role/);
  });
});
