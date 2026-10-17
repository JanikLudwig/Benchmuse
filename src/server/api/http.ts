import { cookies, headers } from "next/headers";
import { NextResponse } from "next/server";
import { z } from "zod";
import { getDb, type Db } from "../db/client";
import type { users } from "../db/schema";
import { AppError } from "../services/errors";
import { AuthError, SESSION_COOKIE, requireWriteAccess, userForApiKey, userForSession } from "../services/auth";

export type User = typeof users.$inferSelect;

export interface RequestContext {
  db: Db;
  /** the signed-in user; satisfies the services' `Actor` */
  actor: User;
  /** how the request was authenticated */
  via: "session" | "api-key";
}

/**
 * Resolve the caller from a session cookie or an `Authorization: Bearer` API key.
 *
 * Throws `AuthError` when neither is present or valid, so every route is closed by default
 * rather than relying on each handler to remember to check.
 */
export async function getContext(): Promise<RequestContext> {
  const db = await getDb();
  const [cookieStore, headerStore] = await Promise.all([cookies(), headers()]);

  const bearer = headerStore.get("authorization");
  if (bearer?.startsWith("Bearer ")) {
    const authenticated = await userForApiKey(db, bearer.slice(7).trim());
    if (!authenticated) throw new AuthError("That API key is not valid");
    return { db, actor: authenticated.user, via: "api-key" };
  }

  const token = cookieStore.get(SESSION_COOKIE)?.value;
  if (token) {
    const authenticated = await userForSession(db, token);
    if (authenticated) return { db, actor: authenticated.user, via: "session" };
  }
  throw new AuthError();
}

/** Context without requiring a user, for the sign-in and setup endpoints. */
export async function getOpenContext(): Promise<{ db: Db }> {
  return { db: await getDb() };
}

type RouteParams = { params: Promise<Record<string, string>> };

function errorResponse(status: number, code: string, message: string, details?: unknown) {
  return NextResponse.json({ error: { code, message, ...(details !== undefined && { details }) } }, { status });
}

export interface RouteOptions {
  status?: number;
  /** allow read-only accounts; defaults to false for anything that is not a GET */
  allowViewer?: boolean;
  /** skip authentication entirely (sign-in, health checks) */
  public?: boolean;
}

/** Wrap a route handler: authenticate, inject context and params, map domain errors to JSON. */
export function route(
  handler: (args: { req: Request; ctx: RequestContext; params: Record<string, string> }) => Promise<unknown>,
  opts: RouteOptions = {},
) {
  return async (req: Request, routeParams: RouteParams) => {
    try {
      const [ctx, params] = await Promise.all([getContext(), routeParams.params]);
      // Viewers may read, but not change anything.
      if (!opts.allowViewer && req.method !== "GET" && req.method !== "HEAD") requireWriteAccess(ctx.actor);
      const body = await handler({ req, ctx, params });
      return NextResponse.json(body, { status: opts.status ?? 200 });
    } catch (error) {
      return toErrorResponse(error);
    }
  };
}

export function toErrorResponse(error: unknown): NextResponse {
  if (error instanceof AppError) return errorResponse(error.status, error.code, error.message, error.details);
  if (error instanceof z.ZodError) {
    return errorResponse(400, "bad_request", "Request body does not match the expected shape", {
      issues: error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
    });
  }
  if (error instanceof SyntaxError) return errorResponse(400, "bad_request", "Request body is not valid JSON");
  console.error(error);
  return errorResponse(500, "internal_error", "Something went wrong");
}

/** A route that does not require authentication. */
export function publicRoute(
  handler: (args: { req: Request; db: Db; params: Record<string, string> }) => Promise<Response>,
) {
  return async (req: Request, routeParams: RouteParams) => {
    try {
      const [{ db }, params] = await Promise.all([getOpenContext(), routeParams.params]);
      return await handler({ req, db, params });
    } catch (error) {
      return toErrorResponse(error);
    }
  };
}

export async function parseBody<T extends z.ZodType>(req: Request, schema: T): Promise<z.infer<T>> {
  return schema.parse(await req.json());
}

export function searchParams(req: Request) {
  return new URL(req.url).searchParams;
}

export function intParam(value: string | null): number | undefined {
  if (value === null || value === "") return undefined;
  const n = Number(value);
  return Number.isInteger(n) ? n : undefined;
}
