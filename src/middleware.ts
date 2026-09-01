import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { SESSION_COOKIE, getSessionUser, needsSetup } from "@/lib/auth";
import { csrfVerdict, expectedOrigin } from "@/lib/csrf";
import { isPublicPage } from "@/lib/publicPages";
import { httpsIsGuaranteed, securityHeaders } from "@/lib/securityHeaders";

/**
 * Gate every page and API route behind a signed-in account (§9), refuse the
 * mutations that shouldn't trust the session cookie alone (Phase 6), and
 * stamp every response with this app's security headers.
 *
 * Runs on the Node runtime rather than the Edge default because sessions are
 * database rows — validating one means a Prisma query, and revocation only
 * works if it happens here rather than whenever a cookie lapses. That same
 * runtime choice is what makes it possible to generate the CSP nonce here too
 * (`node:crypto`, not Edge-only Web Crypto trivia) and have it be the one
 * thing in this file a static config in next.config.mjs could never do: a
 * nonce has to be different on every response, and next.config.mjs's headers
 * are computed once, at build time, for every request alike.
 */
export const runtime = "nodejs";

/** Routes reachable without a session, because they're how you get one. */
function isPublic(pathname: string): boolean {
  return (
    // The pages: the landing page, the sign-in and password-reset flow, the
    // invitation pages, first-run setup. Kept in src/lib/publicPages.ts
    // because src/components/TopNav.tsx has to gate on the same list — a page
    // this function lets through anonymously must not be a page that draws a
    // nav bar of links to somewhere anonymous callers can't go.
    isPublicPage(pathname) ||
    // The endpoints behind those pages. The page half and the API half are
    // separate lists on purpose: the whole reason /api/login is open is that
    // it is how you *stop* being anonymous, and that is not a property the
    // nav bar or anything else should infer from a page being public.
    pathname === "/api/login" ||
    pathname === "/api/password/forgot" ||
    pathname === "/api/password/reset" ||
    // Accepting an invitation is the one way into the app for somebody with no
    // account at all, so the page and the endpoint that spends the link both
    // have to answer without a session. The link itself is the credential:
    // hashed, single-use, seven days, bound to one address (§9).
    pathname === "/api/invitations/accept" ||
    // First-run bootstrap: a fresh deployment has nobody to sign in as. The
    // route closes itself the moment an account exists (needsSetup in
    // src/lib/auth.ts, checked inside src/app/api/setup/route.ts on every
    // call) — this entry only has to stay open, not stay safe, since the
    // route re-derives "safe" for itself on every request.
    pathname === "/api/setup" ||
    // One-click unsubscribe has to work straight from a mail client, which
    // carries no session (§9b). It authenticates with its own `t` parameter
    // (an HMAC over the user and household — isValidUnsubscribeToken in
    // src/lib/auth.ts), and it's a GET, so it never reaches the CSRF check
    // below regardless.
    pathname === "/api/newsletter/unsubscribe" ||
    // The weekly send is triggered by cron and authenticates with CRON_SECRET
    // instead of a cookie (§9b).
    pathname === "/api/newsletter/send" ||
    // Backups can likewise be driven from a script with CRON_SECRET rather
    // than a session (§11). The route checks one or the other itself.
    pathname === "/api/backup/run" ||
    // Capture is cross-origin from the recipe site and authenticates with the
    // household capture token instead of the session cookie.
    pathname === "/api/capture" ||
    // Next's own reserved namespace. /_next/static and /_next/image never
    // reach middleware at all (excluded below in `config.matcher`, since a
    // hashed build asset can't carry a session and shouldn't pay for a
    // Prisma round trip to be told so); what's left under here at runtime is
    // framework plumbing that isn't a page of this app either — the webpack
    // dev server's HMR socket (`/_next/webpack-hmr`) chief among them. There
    // is nothing to protect at a path Next reserves for itself.
    pathname.startsWith("/_next") ||
    // Home-screen install assets must load before the user has a session.
    // Listed exactly rather than by prefix (unlike the /_next case above,
    // this *is* app-servable namespace) — a future route that happens to
    // start with "icon" is not automatically one of these four static files.
    pathname === "/manifest.webmanifest" ||
    pathname === "/icon.png" ||
    pathname === "/apple-icon.png" ||
    pathname === "/icon-192.png" ||
    pathname === "/icon-512.png" ||
    pathname === "/icon-maskable-512.png" ||
    // Offline support: the service worker and its fallback page load
    // independently of the session.
    pathname === "/sw.js" ||
    pathname === "/offline.html" ||
    pathname === "/favicon.ico"
  );
}

/**
 * The one response this middleware does not get to add its own
 * Content-Security-Policy to. src/app/api/trips/[id]/receipt/route.ts serves
 * raw uploaded receipt bytes under a MIME type it re-derives rather than
 * trusts (safeReceiptContentType in src/lib/receiptPhoto.ts) and sets its own
 * one-line policy — `default-src 'none'; sandbox` — deliberately stricter
 * than the app-wide one below, because this response's whole job is to be
 * unable to render or reach anywhere no matter what the bytes turn out to be.
 *
 * Whether a header set here in middleware and a same-named header set later
 * by a Route Handler get merged, appended, or one silently replaces the other
 * is not documented behaviour worth wagering that response's isolation on —
 * so this app-wide CSP simply isn't applied to it at all, and its own header
 * is the only one the browser ever sees. The rest of this file's headers
 * (X-Frame-Options, HSTS, and so on) still apply; the route already
 * duplicates the one of those it specifically cares about (`nosniff`), and a
 * duplicate identical header value is harmless either way.
 */
function ownsItsCsp(pathname: string): boolean {
  return /^\/api\/trips\/[^/]+\/receipt$/.test(pathname);
}

export async function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;

  // Generated once per request, independent of every branch below, so that a
  // 401, a redirect and an ordinary page all carry the same nonce a Server
  // Component reading it back would expect and the same CSP the browser will
  // actually enforce against whatever body ends up in the response.
  const nonce = Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString("base64");
  const allowEval = process.env.NODE_ENV !== "production";
  const httpsGuaranteed = httpsIsGuaranteed({
    nodeEnv: process.env.NODE_ENV,
    appUrl: process.env.APP_URL,
  });
  const headerList = securityHeaders({ nonce, allowEval, httpsGuaranteed });

  function finish(res: NextResponse): NextResponse {
    for (const [name, value] of headerList) {
      if (name === "Content-Security-Policy" && ownsItsCsp(pathname)) continue;
      res.headers.set(name, value);
    }
    return res;
  }

  // Origin/CSRF check first, ahead of the public/session split below: it has
  // to cover /api/setup and /api/login too (a forged race against a fresh
  // instance's setup endpoint, or a forced-login CSRF, are both real even
  // though neither one needs an existing session), and every mutation this
  // app answers already lives under a path this function recognizes or the
  // bearer/path exemptions inside csrfVerdict cover explicitly.
  const csrf = csrfVerdict({
    method: req.method,
    pathname,
    originHeader: req.headers.get("origin"),
    refererHeader: req.headers.get("referer"),
    authorizationHeader: req.headers.get("authorization"),
    expectedOrigin: expectedOrigin({
      appUrl: process.env.APP_URL,
      nodeEnv: process.env.NODE_ENV,
      requestOrigin: req.nextUrl.origin,
    }),
  });
  if (csrf === "block") {
    // A body that says nothing an attacker didn't already know — not which
    // check failed, not what the expected origin was.
    return finish(NextResponse.json({ error: "request rejected" }, { status: 403 }));
  }

  // The nonce has to reach whatever Server Component renders the page, not
  // just the eventual response, so it's threaded onto the request Next hands
  // downstream — the pattern Next's own CSP guide documents this exact
  // header name for.
  const forwardedRequestHeaders = new Headers(req.headers);
  forwardedRequestHeaders.set("x-nonce", nonce);
  const next = () => NextResponse.next({ request: { headers: forwardedRequestHeaders } });

  if (isPublic(pathname)) return finish(next());

  const user = await getSessionUser(req.cookies.get(SESSION_COOKIE)?.value);
  if (user) return finish(next());

  // API callers get 401; page navigations bounce to a sign-in.
  if (pathname.startsWith("/api/")) {
    return finish(NextResponse.json({ error: "unauthorized" }, { status: 401 }));
  }

  const url = req.nextUrl.clone();
  url.search = "";

  // Only worth a query once we already know there's no session: an instance
  // with no accounts at all needs bootstrapping, not a login form.
  if (await needsSetup()) {
    url.pathname = "/setup";
    return finish(NextResponse.redirect(url));
  }

  url.pathname = "/login";
  // So signing in lands you where you were headed rather than the dashboard.
  // Unconditional now that the landing page is public: every path that still
  // reaches this line is a page worth being returned to, where it used to have
  // to make an exception for "/" — which was the dashboard, and which nobody
  // wants to be sent back to as if they had asked for it specifically.
  url.searchParams.set("next", pathname + req.nextUrl.search);
  return finish(NextResponse.redirect(url));
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
