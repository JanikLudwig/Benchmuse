import { parseBody, route } from "@/server/api/http";
import { z } from "zod";
import { createApiKey, listApiKeys, revokeApiKey } from "@/server/services/auth";

const createBody = z.object({ name: z.string().min(1).max(100), expiresInDays: z.number().int().min(1).max(3650).optional() });
const revokeBody = z.object({ id: z.string() });

export const GET = route(async ({ ctx }) => ({
  items: (await listApiKeys(ctx.db, ctx.actor.id)).map((k) => ({
    id: k.id,
    name: k.name,
    prefix: k.prefix,
    createdAt: k.createdAt,
    lastUsedAt: k.lastUsedAt,
    expiresAt: k.expiresAt,
    revokedAt: k.revokedAt,
  })),
}));

/** Create a key. The token is returned once here and never again. */
export const POST = route(
  async ({ req, ctx }) => {
    const body = await parseBody(req, createBody);
    const expiresAt = body.expiresInDays ? new Date(Date.now() + body.expiresInDays * 86400_000) : undefined;
    const { key, token } = await createApiKey(ctx.db, ctx.actor.id, body.name, expiresAt);
    return { key: { id: key.id, name: key.name, prefix: key.prefix, expiresAt: key.expiresAt }, token };
  },
  { status: 201 },
);

export const DELETE = route(async ({ req, ctx }) => {
  await revokeApiKey(ctx.db, ctx.actor.id, (await parseBody(req, revokeBody)).id);
  return { revoked: true };
});
