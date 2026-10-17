import { notFound, redirect } from "next/navigation";
import { connection } from "next/server";
import { getContext, getOpenContext, type RequestContext } from "./api/http";
import type { Db } from "./db/client";
import { AuthError } from "./services/auth";
import { NotFoundError } from "./services/errors";

/**
 * For server components: opt the page out of build-time prerendering (it reads live data),
 * then return the db and the signed-in user.
 *
 * Pages that are not signed in are sent to /signin rather than shown an error.
 */
export async function loadContext(): Promise<RequestContext>;
export async function loadContext(opts: { requireUser: false }): Promise<{ db: Db; actor: null }>;
export async function loadContext(opts?: { requireUser: false }) {
  await connection();
  if (opts?.requireUser === false) return { ...(await getOpenContext()), actor: null };
  try {
    return await getContext();
  } catch (error) {
    if (error instanceof AuthError) redirect("/signin");
    throw error;
  }
}

/** Await a service read, turning NotFoundError into the Next.js 404 page. */
export async function orNotFound<T>(promise: Promise<T>): Promise<T> {
  try {
    return await promise;
  } catch (e) {
    if (e instanceof NotFoundError) notFound();
    throw e;
  }
}
