/**
 * Where a `?next=` parameter is allowed to send somebody (§9, Phase 6).
 *
 * The invitation flow asks an existing account to sign in and come back, so
 * the login page carries a return path. That makes this the one place where a
 * value out of the query string decides a navigation, which is the shape an
 * open redirect always has: an attacker mails "log in at <the real app>", the
 * victim signs in for real, and the app itself hands them to a lookalike that
 * asks for the password again.
 *
 * The obvious guard — starts with "/" but not "//" — is not enough. Browsers
 * follow the WHATWG URL rules, where a backslash is a path separator like any
 * other, so `/\evil.com` passes that test and still resolves to
 * `https://evil.com/`. Rather than grow a list of the separators and encodings
 * that behave this way, resolve the candidate against the real origin and
 * insist the answer is still that origin: the parser deciding what a string
 * means is the same parser the browser will use.
 *
 * Returns a path that is always safe to navigate to — the fallback when the
 * candidate is absent, unparseable or off-origin.
 */
export function safeNextPath(
  candidate: string | null | undefined,
  origin: string,
  fallback = "/",
): string {
  if (!candidate) return fallback;
  let url: URL;
  try {
    url = new URL(candidate, origin);
  } catch {
    return fallback;
  }
  // A candidate that names another origin is refused outright rather than
  // stripped down to its path: "https://evil.com/plan" is not a request to
  // visit /plan, it is a request to leave, and honouring half of it would be
  // guessing at an intent nobody had.
  if (url.origin !== new URL(origin).origin) return fallback;
  return url.pathname + url.search + url.hash;
}
