/**
 * The security response headers every page and API response carries, and the
 * Content Security Policy in particular, computed as pure functions of a
 * handful of inputs (Phase 6, §9, §10).
 *
 * Separate from src/middleware.ts for the same reason src/lib/csrf.ts is:
 * the only interesting thing about a CSP is the string itself, and the plan
 * ("The CSP must be tested") means that string has to be checkable — nonce
 * substitution, the HSTS gate, the absence of `unsafe-eval` in production —
 * without standing up a server. src/lib/securityHeaders.test.mjs exercises all
 * of it directly; src/middleware.ts only calls `securityHeaders` and applies
 * whatever it returns.
 *
 * One exception lives in src/middleware.ts rather than here: whether to apply
 * these headers at all to a given response. src/app/api/trips/[id]/receipt/route.ts
 * sets its own, stricter, one-line CSP (`default-src 'none'; sandbox`) because
 * it serves raw uploaded bytes of a MIME type nothing here can fully vouch
 * for, and Next.js's exact merge behaviour between a header set in middleware
 * and one set later by a Route Handler on the same response is not something
 * to gamble a security header on. Middleware knows which path that is; this
 * module has no notion of "routes" at all, on purpose.
 */

/** What the nonce and the dev/prod distinction need to build one CSP string. */
export interface CspInput {
  /** Per-request, so two responses never share a trusted inline-script token. */
  nonce: string;
  /**
   * Whether `'unsafe-eval'` belongs in `script-src`. Next's dev server (both
   * webpack and Turbopack) evaluates its own bundles for hot-reloading, so a
   * strict `script-src` breaks `npm run dev` outright — not a page rendering
   * oddly, the dev server failing to boot the app at all. Production's build
   * output never calls `eval`, so this is the one directive allowed to differ
   * between environments, and it is *only* this one.
   */
  allowEval: boolean;
}

/**
 * The Content-Security-Policy header value.
 *
 * Every directive here is a deliberate `'self'`-or-tighter choice, checked
 * against what the app actually loads (Phase 6 audit):
 *
 * - `script-src`: `'nonce-…' 'strict-dynamic'` rather than `'unsafe-inline'`
 *   because the App Router's own hydration bootstrap is an inline `<script>`
 *   Next generates per request — a nonce is the mechanism Next itself
 *   documents for this, and `'strict-dynamic'` is needed alongside it so the
 *   scripts *that* script loads (route chunks, code-split imports) inherit
 *   trust instead of needing their own nonce or a URL allowlist. `'self'` is
 *   included too, inert wherever `'strict-dynamic'` is honoured, but a
 *   fallback for a browser old enough not to understand it.
 * - `style-src`: `'unsafe-inline'` is a real relaxation, not a default left
 *   in place. It is forced by roughly two dozen page and component files
 *   across `src/app` and `src/components` using React's `style={{...}}` prop
 *   (an inline `style="…"` attribute at render time) rather than CSS classes
 *   — none of them are this task's files to rewrite, and a nonce cannot be
 *   attached to a plain style attribute the way it can to a `<script>` tag,
 *   so there is no tighter option available without that rewrite.
 * - `img-src`, `font-src`, `connect-src`: `'self'` only. Recipe and receipt
 *   photos are downloaded once and re-served from this app's own `/api`
 *   routes (src/lib/recipeImage.ts) rather than hot-linked, OCR runs
 *   server-side inside the Node process (src/lib/ocr.ts — tesseract.js is in
 *   `serverExternalPackages`, never shipped to the browser), and there is no
 *   webfont or third-party API call from client code (§12's no-external-API
 *   rule, holding here too).
 * - `worker-src 'self'`: stated explicitly rather than left to fall back to
 *   `script-src`, because that fallback would inherit `'strict-dynamic'` —
 *   whether that also governs worker script *registration* (the service
 *   worker at `/sw.js`) is exactly the kind of cross-directive interaction
 *   not worth wagering the offline mode on when a one-line directive removes
 *   the question.
 * - `object-src 'none'`, `base-uri 'self'`, `form-action 'self'`: nothing in
 *   this app uses `<object>`/`<embed>`, a `<base>` tag, or a form posting
 *   anywhere but back to itself.
 * - `frame-ancestors 'none'`: nothing here is meant to be framed by anybody,
 *   including this app's own pages.
 *
 * No `report-uri`/`report-to`: this box has no external endpoint to send
 * reports to and §12 rules out standing one up just for this.
 */
export function buildCsp(input: CspInput): string {
  const scriptSrc = [
    "'self'",
    `'nonce-${input.nonce}'`,
    "'strict-dynamic'",
    input.allowEval ? "'unsafe-eval'" : null,
  ]
    .filter((part): part is string => part !== null)
    .join(" ");

  return [
    "default-src 'self'",
    `script-src ${scriptSrc}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self'",
    "font-src 'self'",
    "connect-src 'self'",
    "worker-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join("; ");
}

/**
 * Permissions-Policy: turn off the powerful browser features this app has no
 * use for. Receipt capture is a plain `<input type="file" accept="image/*">`
 * (src/app/spending/page.tsx, src/app/recipes/[id]/edit/page.tsx) — the OS's
 * own picker, not `getUserMedia` — so denying `camera`/`microphone` outright
 * costs nothing. Nothing here takes payments, reads location, or talks to
 * USB/serial/HID devices.
 */
const PERMISSIONS_POLICY =
  "camera=(), microphone=(), geolocation=(), payment=(), usb=()";

/**
 * Whether it is safe to tell every visiting browser, for the next `max-age`
 * seconds, to refuse plain HTTP for this host — the one header on this list
 * that is dangerous to send speculatively, because a browser that has taken
 * it cannot be told to forget it early; only time, or the same header with
 * `max-age=0`, undoes it, and nothing here can push that to a browser that
 * never comes back.
 *
 * Gated on two things at once, both required: `NODE_ENV=production` alone
 * proves nothing — `npm run build && npm start` on a laptop with no TLS in
 * front of it is still "production" — so this also parses `APP_URL` and
 * requires its scheme to actually be `https:`. That is the same value the
 * origin check in src/lib/csrf.ts already treats as this installation's one
 * source of truth for what its own address is, which keeps "is HTTPS
 * guaranteed" answerable from server configuration alone rather than from
 * anything the request itself claims — a request can't be trusted to prove
 * the channel it arrived on is the one that will still be true for the next
 * six months.
 */
export function httpsIsGuaranteed(opts: {
  nodeEnv: string | undefined;
  appUrl: string | undefined;
}): boolean {
  if (opts.nodeEnv !== "production") return false;
  try {
    return new URL(opts.appUrl ?? "").protocol === "https:";
  } catch {
    return false;
  }
}

export interface SecurityHeadersInput extends CspInput {
  httpsGuaranteed: boolean;
}

/**
 * Every header this app sends on every response, as name/value pairs rather
 * than a `Headers` instance so this stays framework-agnostic and trivial to
 * assert against in a test.
 */
export function securityHeaders(input: SecurityHeadersInput): [string, string][] {
  const headers: [string, string][] = [
    ["Content-Security-Policy", buildCsp(input)],
    // Belt-and-braces alongside frame-ancestors for a client old enough not
    // to parse CSP2 at all.
    ["X-Frame-Options", "DENY"],
    ["X-Content-Type-Options", "nosniff"],
    // Not the browser default (`strict-origin-when-cross-origin`), which
    // still forwards a request's full path — including the query-free but
    // still-secret `/reset/<token>` and `/invite/<token>` paths (§9) — to any
    // *same*-origin destination. Nothing in this app reads a referrer for any
    // legitimate purpose, so there is no tradeoff being made by sending none
    // at all rather than trusting same-origin not to leak it onward.
    ["Referrer-Policy", "no-referrer"],
    ["Permissions-Policy", PERMISSIONS_POLICY],
    // Isolates this app's browsing context group from anything that opened
    // or was opened from it. Nothing here relies on window.opener/postMessage
    // with another origin, so there's no feature this could break.
    ["Cross-Origin-Opener-Policy", "same-origin"],
  ];

  if (input.httpsGuaranteed) {
    // Six months, not the two years a preload-list submission wants — this
    // the deployment does not need preload-list duration (§10), so there is no
    // reason to pick the longer, harder-to-walk-back number.
    headers.push(["Strict-Transport-Security", "max-age=15552000; includeSubDomains"]);
  }

  return headers;
}
