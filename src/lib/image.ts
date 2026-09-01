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
import * as http from "node:http";
import * as https from "node:https";
import { Readable } from "node:stream";
import { classifyAddress } from "./privateNetwork.ts";
import { MAX_IMAGE_BYTES } from "./recipeImage.ts";

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
 * record says. `guardedFetch` uses the richer target returned by
 * `resolvePublicTarget` below so the exact checked address is also the one the
 * socket connects to.
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

  return (await resolvePublicTarget(url))?.url.toString() ?? null;
}

interface PublicTarget {
  url: URL;
  address: string;
  family: 4 | 6;
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
 * Resolve every address for a URL, refuse the whole target if any address is
 * private, and retain one validated address for the connection itself.
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
 * Returning the address rather than only a boolean is the important part:
 * `requestPinned` below connects directly to it while preserving the original
 * Host header and TLS server name. DNS is therefore consulted exactly once per
 * redirect hop; a rebinding answer cannot replace the checked address between
 * validation and connection.
 */
async function resolvePublicTarget(url: URL): Promise<PublicTarget | null> {
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  if (classifyAddress(hostname) !== null) return null;

  let records: Array<{ address: string; family: number }>;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    records = await Promise.race([
      lookup(hostname, { all: true, verbatim: true }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("DNS lookup timed out")), DNS_TIMEOUT_MS);
      }),
    ]);
  } catch {
    // NXDOMAIN, a resolver timeout, no network — all mean "can't confirm
    // this is safe," which for a guard is the same answer as "unsafe."
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }

  if (
    records.length === 0 ||
    records.some(
      (record) =>
        (record.family !== 4 && record.family !== 6) || classifyAddress(record.address) !== null,
    )
  ) {
    return null;
  }

  return { url, address: records[0].address, family: records[0].family as 4 | 6 };
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/** More redirects than any real recipe site or CDN needs in practice. */
const MAX_REDIRECTS = 5;

/**
 * One HTTP(S) GET whose socket is pinned to the address the guard validated.
 * The URL's hostname still travels as Host and, for HTTPS, as SNI so ordinary
 * virtual hosting and certificate verification keep working.
 */
function requestPinned(
  target: PublicTarget,
  init: { headers: Record<string, string>; timeoutMs: number },
): Promise<Response> {
  const client = target.url.protocol === "https:" ? https : http;
  const headers = {
    ...init.headers,
    host: target.url.host,
    // Native fetch transparently decompresses. Asking for identity keeps this
    // lower-level request's Response semantics the same for its callers.
    "accept-encoding": "identity",
  };

  return new Promise((resolve, reject) => {
    const request = client.request(
      {
        protocol: target.url.protocol,
        hostname: target.address,
        family: target.family,
        port: target.url.port || undefined,
        path: `${target.url.pathname}${target.url.search}`,
        method: "GET",
        headers,
        ...(target.url.protocol === "https:" ? { servername: target.url.hostname } : {}),
      },
      (incoming) => {
        const responseHeaders = new Headers();
        for (const [name, value] of Object.entries(incoming.headers)) {
          if (Array.isArray(value)) value.forEach((item) => responseHeaders.append(name, item));
          else if (value !== undefined) responseHeaders.set(name, value);
        }

        const status = incoming.statusCode ?? 502;
        const bodyForbidden = status === 204 || status === 205 || status === 304;
        if (bodyForbidden) incoming.resume();
        const response = new Response(
          bodyForbidden ? null : (Readable.toWeb(incoming) as ReadableStream),
          {
            status,
            statusText: incoming.statusMessage,
            headers: responseHeaders,
          },
        );
        Object.defineProperty(response, "url", { value: target.url.toString() });
        resolve(response);
      },
    );
    request.setTimeout(init.timeoutMs, () => request.destroy(new Error("request timed out")));
    request.on("error", reject);
    request.end();
  });
}

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
    let url: URL;
    try {
      url = new URL(next, base);
    } catch {
      return null;
    }
    if (
      (url.protocol !== "http:" && url.protocol !== "https:") ||
      url.username ||
      url.password ||
      (url.port && url.port !== "80" && url.port !== "443")
    ) return null;

    const target = await resolvePublicTarget(url);
    if (!target) return null;

    let res: Response;
    try {
      res = await requestPinned(target, init);
    } catch {
      return null;
    }

    if (!REDIRECT_STATUSES.has(res.status)) return res;

    const location = res.headers.get("location");
    if (!location) return null;
    await res.body?.cancel().catch(() => {});
    next = location;
    base = target.url.toString();
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
 * Read a response body in chunks, bailing the moment the running total
 * exceeds `maxBytes` — the size cap that used to live only in the check
 * *after* `res.arrayBuffer()`/`res.text()` had already finished buffering the
 * whole thing. `Content-Length` is a declaration, not a fact: a host that
 * omits it, or lies and sends more than it claimed, used to cost this server
 * an unbounded allocation before that check ever ran, which from a box about
 * to face the open internet is a one-request memory-exhaustion DoS handed to
 * anyone who can get a URL pasted into a recipe. Reading the stream ourselves
 * means the cap bounds what is actually allocated, not what a hostile host
 * merely reported.
 *
 * Shared by `fetchImage` here and `fetchPageHtml` in `fetchPage.ts`, which
 * used to each buffer-then-check the same way — one read-with-a-cap loop
 * beats two copies that could quietly drift apart.
 *
 * Returns null for "too big," the same as for every other kind of failure
 * this module reports, rather than throwing: every caller already treats a
 * null result as "give up on this fetch," so a second error channel just for
 * this one reason would be a distinction none of them use. The underlying
 * stream is cancelled before returning, so the connection doesn't sit there
 * draining bytes nobody wants.
 */
export async function readCapped(res: Response, maxBytes: number): Promise<Buffer | null> {
  const body = res.body;
  if (!body) return Buffer.alloc(0);

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        return null;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), total);
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

    // Trust the declared length when it's there — it saves reading anything
    // at all for the common case of an honestly-labelled oversized file — but
    // `readCapped` is what actually enforces the limit, because a wrong or
    // absent Content-Length must not get us a 200 MB buffer.
    const declared = Number(res.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > MAX_IMAGE_BYTES) return null;

    const bytes = await readCapped(res, MAX_IMAGE_BYTES);
    if (!bytes || bytes.byteLength === 0) return null;

    return { bytes, mime };
  } catch {
    return null;
  }
}
