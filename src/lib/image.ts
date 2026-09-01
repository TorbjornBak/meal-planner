/**
 * Getting a recipe photo into the database.
 *
 * A recipe page advertises its photo in its metadata (see
 * `extractRecipeImageUrl`). We download that one image and store the bytes
 * ourselves rather than hotlinking: the app has to work offline over Tailscale
 * (§10), and a hotlinked photo dies the day the source site reorganizes.
 *
 * `resolvePublicUrl` below is the shared private-network guard for every URL
 * the server fetches — both the photo here and, for the paste-a-URL import
 * (§1), the recipe page itself (see `fetchPage.ts`). It is built on the pure
 * range table in `privateNetwork.ts`; this module adds the two things that
 * need a live network to do — resolving a hostname to what it actually
 * points at, and re-checking every hop of a redirect.
 */

import { lookup } from "node:dns/promises";
import { classifyAddress } from "./privateNetwork";
import { MAX_IMAGE_BYTES } from "./recipeImage";

/** Formats a browser will render inline without a plugin or conversion. */
const ALLOWED_MIME = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
  "image/avif",
]);

export interface FetchedImage {
  bytes: Buffer;
  mime: string;
}

/**
 * Resolve a possibly-relative URL against the page it came from, and confirm
 * every address it currently resolves to is one this server is willing to
 * connect to.
 *
 * Returns null for anything that isn't a plain http(s) URL with no embedded
 * credentials, on the default port, whose hostname resolves only to public
 * addresses — including a private-network address, so a malicious recipe
 * page can't use the capture endpoint to probe the household's own tailnet
 * (§10) or the box's own loopback.
 *
 * This is async, unlike a plain hostname-string check, because "resolves
 * only to public addresses" requires actually resolving it: `isPrivateHost`
 * used to check the literal hostname a URL was built from, which passes a
 * hostname like `evil.example.com` straight through no matter what its DNS
 * record says. See the residual-risk note on `lookupIsSafe` below for what
 * checking the resolved address here still doesn't close.
 */
export async function resolvePublicUrl(
  raw: string,
  pageUrl?: string | null,
): Promise<string | null> {
  let url: URL;
  try {
    url = new URL(raw, pageUrl ?? undefined);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;

  // A recipe page or its photo never legitimately needs to hand us
  // credentials or a non-default port; both are more useful to an attacker
  // trying to make a URL parse ambiguously than to a real recipe site, so
  // refusing them outright costs the feature nothing.
  if (url.username || url.password) return null;
  if (url.port && url.port !== "80" && url.port !== "443") return null;

  return (await hostIsSafe(url.hostname)) ? url.toString() : null;
}

/**
 * Bound how long a single DNS lookup is allowed to take, independent of the
 * fetch timeout that follows it. `dns.lookup` has no `AbortSignal` of its
 * own (unlike `fetch`), so a resolver that hangs instead of erroring would
 * otherwise stall the request before the fetch's own timeout ever starts
 * counting.
 */
const DNS_TIMEOUT_MS = 5_000;

/**
 * Whether every address `hostname` resolves to right now is one this server
 * may connect to.
 *
 * Checking the *resolved* address rather than the literal hostname is what
 * closes the DNS gap (§10, Phase 6): `evil.example.com` whose A record is
 * `127.0.0.1` used to sail through a check that only looked at the string
 * "evil.example.com". It also happens to close the alternative-encoding
 * bypasses (decimal/octal/hex IPv4) for free, and for a reason worth being
 * precise about: it's not that resolving the name launders the encoding —
 * `dns.lookup` never even sees a string like `2130706433`, because the URL
 * constructor's own IPv4 parser (the WHATWG "special scheme" host parsing
 * that `new URL(raw)` runs) already rewrote `url.hostname` to `127.0.0.1`
 * before this function was called. `privateNetwork.ts`'s own `parseIPv4`
 * accepts the same encodings independently, so this module doesn't rest
 * entirely on that upstream behaviour, but the credit for closing this
 * particular bypass belongs to the URL parser, not the DNS lookup.
 *
 * **What this does not close.** Between this lookup returning "safe" and
 * the fetch that follows it actually opening a connection, the name can
 * re-resolve to a different, private address (DNS rebinding) — Node's global
 * `fetch` resolves the hostname again itself when it connects, with no way
 * to hand it the address we already validated. Closing that fully means
 * pinning the exact validated IP into the connection, which would mean
 * reaching for undici's `Agent`/`Dispatcher` with a custom `connect` hook
 * instead of the platform `fetch`. That's a real dependency-shaped change,
 * not a couple of lines, so it isn't done here; this function only narrows
 * the window from "no check at all" to "a check immediately before the
 * request, redone on every redirect hop." A recipe site running a
 * rebinding attack against its own readers is a threat model far past what
 * this app's guard is trying to cover.
 */
async function hostIsSafe(hostname: string): Promise<boolean> {
  if (classifyAddress(hostname) !== null) return false;

  let addresses: string[];
  try {
    const records = await Promise.race([
      lookup(hostname, { all: true, verbatim: true }),
      new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error("DNS lookup timed out")), DNS_TIMEOUT_MS);
      }),
    ]);
    addresses = records.map((r) => r.address);
  } catch {
    // NXDOMAIN, a resolver timeout, no network — all mean "can't confirm
    // this is safe," which for a guard is the same answer as "unsafe."
    return false;
  }

  return addresses.length > 0 && addresses.every((a) => classifyAddress(a) === null);
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/** More redirects than any real recipe site or CDN needs in practice. */
const MAX_REDIRECTS = 5;

/**
 * Fetch a URL, re-running the full guard — DNS resolution included — on
 * every redirect hop.
 *
 * `fetch(url, { redirect: "follow" })` validates only the URL you handed it;
 * a public, allowed URL can still 302 straight to `http://169.254.169.254/`
 * or a tailnet peer, and the browser-style automatic follow would take it
 * there without this module ever seeing the address. Handling redirects by
 * hand — `redirect: "manual"`, read `Location`, validate, repeat — means the
 * address on every hop, not just the first, goes through `resolvePublicUrl`.
 * The hop cap exists so a redirect chain can't be used to make this run
 * forever rather than just somewhere it shouldn't.
 *
 * Returns null for anything that isn't a normal terminal response: a blocked
 * or unparseable URL at any hop, a redirect with no `Location`, a network
 * error, or more hops than `MAX_REDIRECTS`. Every caller of this treats the
 * whole fetch as best-effort, so null and "the page doesn't exist" must look
 * the same from the outside.
 */
export async function guardedFetch(
  rawUrl: string,
  init: { headers: Record<string, string>; timeoutMs: number },
): Promise<Response | null> {
  let next = rawUrl;
  let base: string | undefined;

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const safe = await resolvePublicUrl(next, base);
    if (!safe) return null;

    let res: Response;
    try {
      res = await fetch(safe, {
        redirect: "manual",
        signal: AbortSignal.timeout(init.timeoutMs),
        headers: init.headers,
      });
    } catch {
      return null;
    }

    if (!REDIRECT_STATUSES.has(res.status)) return res;

    const location = res.headers.get("location");
    if (!location) return null;
    next = location;
    base = safe;
  }

  return null;
}

/** The bare type from a Content-Type header, if it's an image we accept. */
export function normalizeMime(header: string | null): string | null {
  if (!header) return null;
  const mime = header.split(";")[0].trim().toLowerCase();
  return ALLOWED_MIME.has(mime) ? mime : null;
}

/**
 * Download an image, or return null if anything at all goes wrong — a dead
 * link, a redirect to an HTML error page, an oversized file, a slow host, a
 * URL the private-network guard refuses. Every caller treats the photo as
 * optional, so failure is never an error.
 */
export async function fetchImage(url: string): Promise<FetchedImage | null> {
  try {
    const res = await guardedFetch(url, {
      timeoutMs: 10_000,
      headers: {
        // Some CDNs serve a 403 to clients that send no User-Agent at all.
        "user-agent": "MealPlanner/1.0 (household recipe app)",
        accept: "image/*",
      },
    });
    if (!res || !res.ok) return null;

    const mime = normalizeMime(res.headers.get("content-type"));
    if (!mime) return null;

    // Trust the declared length when it's there, but re-check after reading —
    // a wrong or absent Content-Length must not get us a 200 MB buffer.
    const declared = Number(res.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > MAX_IMAGE_BYTES) return null;

    const bytes = Buffer.from(await res.arrayBuffer());
    if (bytes.byteLength === 0 || bytes.byteLength > MAX_IMAGE_BYTES) return null;

    return { bytes, mime };
  } catch {
    return null;
  }
}
