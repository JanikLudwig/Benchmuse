import { NextResponse, type NextRequest } from "next/server";

const SESSION_COOKIE = "benchmuse_session";

/**
 * Send signed-out visitors to the sign-in page before a page renders.
 *
 * This is a routing convenience, not the security boundary: every API route and server
 * component authenticates for itself, because a cookie being present says nothing about
 * whether the session behind it is still valid.
 */
export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const isAuthPage = pathname.startsWith("/signin") || pathname.startsWith("/setup");
  const hasSession = request.cookies.has(SESSION_COOKIE);

  if (!hasSession && !isAuthPage) {
    const url = request.nextUrl.clone();
    url.pathname = "/signin";
    // Remember where they were headed so sign-in can return them there.
    if (pathname !== "/") url.searchParams.set("next", pathname);
    return NextResponse.redirect(url);
  }
  if (hasSession && isAuthPage) {
    const url = request.nextUrl.clone();
    url.pathname = "/";
    url.search = "";
    return NextResponse.redirect(url);
  }
  return NextResponse.next();
}

export const config = {
  // Everything except API routes (which answer with 401 rather than redirecting) and assets.
  matcher: ["/((?!api|_next/static|_next/image|favicon.ico|icon.svg).*)"],
};
