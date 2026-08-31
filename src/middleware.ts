import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { SESSION_COOKIE, getSessionUser, needsSetup } from "@/lib/auth";

/**
 * Gate every page and API route behind a signed-in account (§9).
 *
 * Runs on the Node runtime rather than the Edge default because sessions are
 * database rows — validating one means a Prisma query, and revocation only
 * works if it happens here rather than whenever a cookie lapses.
 */
export const runtime = "nodejs";

/** Routes reachable without a session, because they're how you get one. */
function isPublic(pathname: string): boolean {
  return (
    pathname === "/login" ||
    pathname === "/api/login" ||
    pathname === "/forgot" ||
    pathname === "/api/password/forgot" ||
    pathname === "/api/password/reset" ||
    pathname.startsWith("/reset/") ||
    // Accepting an invitation is the one way into the app for somebody with no
    // account at all, so the page and the endpoint that spends the link both
    // have to answer without a session. The link itself is the credential:
    // hashed, single-use, seven days, bound to one address (§9).
    pathname.startsWith("/invite/") ||
    pathname === "/api/invitations/accept" ||
    // First-run bootstrap: a fresh deployment has nobody to sign in as.
    pathname === "/setup" ||
    pathname === "/api/setup" ||
    // One-click unsubscribe has to work straight from a mail client, which
    // carries no session (§9b).
    pathname === "/api/newsletter/unsubscribe" ||
    pathname === "/newsletter/unsubscribed" ||
    // The weekly send is triggered by cron and authenticates with CRON_SECRET
    // instead of a cookie (§9b).
    pathname === "/api/newsletter/send" ||
    // Backups can likewise be driven from a script with CRON_SECRET rather
    // than a session (§11). The route checks one or the other itself.
    pathname === "/api/backup/run" ||
    // Capture is cross-origin from the recipe site and authenticates with the
    // household capture token instead of the session cookie.
    pathname === "/api/capture" ||
    pathname.startsWith("/_next") ||
    // Home-screen install assets must load before the user has a session.
    pathname === "/manifest.webmanifest" ||
    pathname === "/apple-icon.png" ||
    pathname.startsWith("/icon") ||
    // Offline support: the service worker and its fallback page load
    // independently of the session.
    pathname === "/sw.js" ||
    pathname === "/offline.html" ||
    pathname === "/favicon.ico"
  );
}

export async function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;

  if (isPublic(pathname)) return NextResponse.next();

  const user = await getSessionUser(req.cookies.get(SESSION_COOKIE)?.value);
  if (user) return NextResponse.next();

  // API callers get 401; page navigations bounce to a sign-in.
  if (pathname.startsWith("/api/")) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const url = req.nextUrl.clone();
  url.search = "";

  // Only worth a query once we already know there's no session: an instance
  // with no accounts at all needs bootstrapping, not a login form.
  if (await needsSetup()) {
    url.pathname = "/setup";
    return NextResponse.redirect(url);
  }

  url.pathname = "/login";
  // So signing in lands you where you were headed rather than the dashboard.
  if (pathname !== "/") url.searchParams.set("next", pathname + req.nextUrl.search);
  return NextResponse.redirect(url);
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
