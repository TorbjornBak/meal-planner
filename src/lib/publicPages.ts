/**
 * The pages of this app a browser may reach with no session at all.
 *
 * Two things need this answer and must never disagree about it. src/middleware.ts
 * asks it to decide whether to let a request through or bounce it to /login;
 * src/components/TopNav.tsx asks it to decide whether to draw the app's nav bar.
 * Kept apart from middleware's own list because that list also covers the API
 * routes that authenticate some other way (a cron secret, an unsubscribe HMAC,
 * a capture token) and the static files a browser fetches before it could
 * possibly have signed in — neither of which is a *page*, and neither of which
 * the nav has any opinion about.
 *
 * A pure function of the pathname, so the two callers can share it across the
 * server/client line: middleware runs it on the Node runtime, TopNav in the
 * browser.
 */
export function isPublicPage(pathname: string): boolean {
  return (
    // The landing page. Public in both directions: a stranger sees what this
    // is and where to sign in, and somebody who is already signed in still
    // gets the page rather than a redirect, because the button on it is how
    // they carry on to the dashboard.
    pathname === "/" ||
    pathname === "/login" ||
    pathname === "/forgot" ||
    // First-run bootstrap. Open because a fresh deployment has nobody to sign
    // in as; the route behind it closes itself the moment an account exists.
    pathname === "/setup" ||
    // Landed on straight from a mail client, which carries no session.
    pathname === "/newsletter/unsubscribed" ||
    pathname.startsWith("/reset/") ||
    // Accepting an invitation is the one way into the app for somebody with no
    // account at all. The link itself is the credential (§9).
    pathname.startsWith("/invite/")
  );
}
