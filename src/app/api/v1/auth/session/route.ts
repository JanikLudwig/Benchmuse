import { NextResponse } from "next/server";
import { z } from "zod";
import { getContext, publicRoute, toErrorResponse } from "@/server/api/http";
import { SESSION_COOKIE, signIn, signOut } from "@/server/services/auth";

const signInBody = z.object({
  handleOrEmail: z.string().min(1).max(200),
  password: z.string().min(1).max(1024),
});

/** Sign in and set the session cookie. */
export const POST = publicRoute(async ({ req, db }) => {
  const body = signInBody.parse(await req.json());
  const { token, expiresAt, user } = await signIn(db, {
    ...body,
    userAgent: req.headers.get("user-agent") ?? undefined,
  });
  const response = NextResponse.json({ user: { id: user.id, handle: user.handle, name: user.name, role: user.role } });
  response.cookies.set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    // Secure cookies would not be sent over plain http in local development.
    secure: process.env.NODE_ENV === "production",
    path: "/",
    expires: expiresAt,
  });
  return response;
});

/** Sign out, clearing the session on both sides. */
export async function DELETE(req: Request) {
  try {
    const { db } = await getContext();
    const token = req.headers.get("cookie")?.match(new RegExp(`${SESSION_COOKIE}=([^;]+)`))?.[1];
    if (token) await signOut(db, decodeURIComponent(token));
    const response = NextResponse.json({ signedOut: true });
    response.cookies.delete(SESSION_COOKIE);
    return response;
  } catch (error) {
    return toErrorResponse(error);
  }
}

/** Who am I? Used by the UI to show the signed-in user. */
export async function GET() {
  try {
    const { actor, via } = await getContext();
    return NextResponse.json({
      user: { id: actor.id, handle: actor.handle, name: actor.name, email: actor.email, role: actor.role },
      via,
    });
  } catch (error) {
    return toErrorResponse(error);
  }
}
