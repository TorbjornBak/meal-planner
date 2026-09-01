/**
 * Whether a state-changing request is allowed to proceed at all, before it
 * ever reaches a session check (Phase 6).
 *
 * `SameSite=Lax` (sessionCookieOptions in src/lib/auth.ts) already stops the
 * classic cross-site `<form>` POST from carrying the session cookie, but it is
 * not the whole story: a handful of browsers still ship pre-SameSite
 * behaviour, and Lax itself still attaches the cookie to a top-level
 * cross-site *navigation* that happens to use POST. The origin check here is
 * the second, independent lock — it doesn't trust the cookie jar at all, only
 * where the request says it came from.
 *
 * Pure, and separate from src/middleware.ts for the same reason
 * rateLimitPolicy.ts is separate from rateLimit.ts: the interesting part is a
 * handful of branches over plain strings, and none of them need a running
 * server or a real `Request` to get right. src/lib/csrf.test.mjs exercises
 * every branch, including the ones a browser would never actually produce,
 * because the whole point of this check is the request that isn't a browser.
 */

/** Methods that change state. GET/HEAD/OPTIONS are read-only by contract. */
const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/**
 * Routes exempted by path rather than by the bearer rule below, and why each
 * one can't use that rule instead.
 *
 * `/api/capture` (src/app/api/capture/route.ts) is legitimately cross-origin:
 * the bookmarklet runs in the page of whatever recipe site the household is
 * reading, and posts back to us from there. It authenticates with a household
 * capture token, but that token travels as a field in the JSON body — the
 * bookmarklet sends `Content-Type: text/plain` specifically to avoid a CORS
 * preflight, which rules out an `Authorization` header too. Reading the body
 * here to look for it would mean buffering and re-streaming an upload this
 * middleware already has to special-case for size (middlewareClientMaxBodySize
 * in next.config.mjs), just to duplicate a check the route already makes. A
 * one-entry path exemption is honest about the real reason: this route's
 * credential doesn't live anywhere the origin check could see it.
 */
const PATH_EXEMPT = new Set(["/api/capture"]);

/** Roughly `Authorization: Bearer <something>` — enough to tell scripts from browsers. */
const BEARER_PATTERN = /^Bearer\s+\S+$/;

export interface OriginCheckInput {
  method: string;
  pathname: string;
  originHeader: string | null;
  refererHeader: string | null;
  authorizationHeader: string | null;
  /**
   * This installation's own origin, or null when it can't be determined
   * (see `expectedOrigin` below). Passed in rather than computed here so this
   * function stays a total function of plain values.
   */
  expectedOrigin: string | null;
}

export type CsrfVerdict = "allow" | "block";

/**
 * Decide whether a mutating request may proceed.
 *
 * The rule is "a request authenticated by a bearer or URL token doesn't need
 * this check; a request that might be riding on the session cookie does" —
 * preferred over a hand-maintained list of every such route, because the list
 * drifts the day somebody adds one and forgets this file. It is expressed here
 * as "carries a well-formed `Authorization: Bearer` header", which covers both
 * `/api/backup/run` and `/api/newsletter/send` (bearerTokenMatches in
 * src/lib/auth.ts) without naming either: a cross-site page cannot attach a
 * custom `Authorization` header to a request without first clearing a CORS
 * preflight, and neither of those routes answers one — there is no
 * `Access-Control-Allow-Origin` on them at all — so the browser never sends
 * the real request. A script with the actual secret can set the header
 * freely; a forged `<form>` or a `fetch` from an attacker's page cannot. This
 * function does not check whether the *value* matches `CRON_SECRET` — that
 * would duplicate a comparison the route already makes under its own
 * constant-time check, and getting it wrong here would only make this file a
 * second place a leaked secret could be validated against.
 *
 * `/api/newsletter/unsubscribe` needs no entry in either list: it is a GET,
 * and GET never reaches this function at all, by design — the one-click link
 * a mail client's own "unsubscribe" button fires is a plain navigation with
 * no `Authorization` header available to it.
 */
export function csrfVerdict(input: OriginCheckInput): CsrfVerdict {
  if (!MUTATING_METHODS.has(input.method)) return "allow";
  if (PATH_EXEMPT.has(input.pathname)) return "allow";
  if (input.authorizationHeader && BEARER_PATTERN.test(input.authorizationHeader)) {
    return "allow";
  }

  // Nothing to compare against. Refusing here rather than letting the request
  // through is the fail-closed direction: a request that carries no evidence
  // of where the app itself lives should never be waved past a check whose
  // entire job is confirming exactly that. See `expectedOrigin` for when this
  // actually happens.
  if (!input.expectedOrigin) return "block";

  const claimed = input.originHeader ?? originOfUrl(input.refererHeader);

  // Every browser shipping today sends `Origin` on a cross-site mutation, and
  // has for years sent it on same-site ones too — `Origin` is the header a
  // browser attaches to the outgoing request itself and cannot be suppressed
  // by the page that triggered it, which is exactly why it is trustworthy
  // where `Referer` (a page merely reporting where it thinks it came from,
  // and routinely stripped by privacy settings) is not. A request with
  // neither is not a browser mutation at all — it's a script, a very old
  // client, or a forged request with the headers stripped on purpose — and
  // none of those are the traffic `SameSite=Lax` plus this check are meant to
  // wave through. Failing closed here costs a legitimate caller nothing that
  // setting one header wouldn't fix, and refusing silently is the safer
  // default for traffic we cannot identify at all.
  if (!claimed) return "block";

  return claimed === input.expectedOrigin ? "allow" : "block";
}

function originOfUrl(raw: string | null): string | null {
  if (!raw) return null;
  try {
    return new URL(raw).origin;
  } catch {
    return null;
  }
}

/**
 * This installation's own origin, as far as the origin check above is allowed
 * to trust it.
 *
 * `APP_URL` (already required for mail links — src/lib/mail.ts) is the
 * source, not the incoming request's `Host` header. Deriving the *expected*
 * origin from a header on the very request being validated would make the
 * check circular: whatever `Host` an attacker's request carries would always
 * equal itself, so nothing could ever fail. It also happens to be wrong in
 * this deployment even before considering attackers — HTTPS terminates at
 * `tailscale serve` and is forwarded to loopback (§10), so the `Host` this
 * process actually sees can be `127.0.0.1:3000` regardless of what the
 * browser's address bar said (the same reason
 * src/app/api/newsletter/unsubscribe/route.ts builds its landing URL from
 * `APP_URL` rather than the request's own origin).
 *
 * Outside production this falls back to the request's own origin instead of
 * refusing everything: `npm run dev` talks to itself on plain HTTP with no
 * proxy in front of it, so there is no untrusted hop for `Host` to lie about,
 * and `.env.example`'s `APP_URL` is a tailnet HTTPS address a developer's
 * local server will never actually be reached at. Refusing every mutation in
 * dev because the placeholder doesn't match `localhost` would just teach
 * whoever hits it to weaken the check instead of configuring `APP_URL`
 * properly before going anywhere near production.
 *
 * In production, a missing or unparsable `APP_URL` returns null rather than
 * guessing — Phase 6 elsewhere fails startup when it's absent, but this
 * function has no way to know that has run, so it treats "can't tell" as
 * "block everything" rather than "allow everything" (see the check above).
 */
export function expectedOrigin(opts: {
  appUrl: string | undefined;
  nodeEnv: string | undefined;
  /** The origin the current request itself arrived on — dev fallback only. */
  requestOrigin: string;
}): string | null {
  const configured = originOfUrl(opts.appUrl ?? null);
  if (configured) return configured;
  return opts.nodeEnv === "production" ? null : opts.requestOrigin;
}
