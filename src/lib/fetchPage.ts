/**
 * Fetching a recipe *page* from the open web — the paste-a-URL import path.
 *
 * This is the fast path in §1: instead of the bookmarklet sending page HTML
 * from your browser, the server fetches it given a URL you paste. It reuses
 * the same private-network guard as the image fetch (`guardedFetch`, built on
 * `resolvePublicUrl` in `image.ts`) so a pasted URL can't be used to probe
 * the host's own network — including its redirects, which `guardedFetch`
 * re-validates hop by hop — and caps the response so a giant page can't
 * exhaust memory.
 *
 * Best-effort by design: many sites (bot protection, JS-only rendering, login
 * walls) won't yield a recipe to a plain server fetch. Every failure returns
 * null so the caller can fall back to the bookmarklet, which always works
 * because it's your real, logged-in browser.
 */

import { guardedFetch, readCapped } from "./image";

/**
 * Recipe pages are large (400–500 KB seen in the wild); cap generously.
 * Exported so `/api/capture` can hold the bookmarklet-submitted HTML — the
 * same kind of content, arriving by a different route — to the same limit.
 */
export const MAX_PAGE_BYTES = 5_000_000;

export interface FetchedPage {
  html: string;
  /** The URL after any redirects — a better source link than what was pasted. */
  finalUrl: string;
}

export async function fetchPageHtml(rawUrl: string): Promise<FetchedPage | null> {
  try {
    const res = await guardedFetch(rawUrl, {
      timeoutMs: 15_000,
      headers: {
        // Recipe sites commonly 403 non-browser clients. This is a low-volume,
        // user-initiated fetch of a page they're about to read anyway, so we
        // present as a normal browser; sites that still block fall back to the
        // bookmarklet.
        "user-agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
          "(KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
        accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "accept-language": "en,da;q=0.8",
      },
    });
    if (!res || !res.ok) return null;

    // Only parse actual HTML — a redirect to a PDF/JSON/image isn't a recipe
    // page, and reading it as text would just produce garbage.
    const ctype = res.headers.get("content-type") ?? "";
    if (!/text\/html|application\/xhtml/i.test(ctype)) return null;

    // Trust the declared length when it's there — see `readCapped` in
    // `image.ts` for why it isn't trusted alone: a page that omits or
    // understates Content-Length must not get us an unbounded buffer just
    // because it isn't a photo.
    const declared = Number(res.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > MAX_PAGE_BYTES) return null;

    const bytes = await readCapped(res, MAX_PAGE_BYTES);
    if (!bytes || bytes.byteLength === 0) return null;

    const html = new TextDecoder("utf-8").decode(bytes);
    if (html.length === 0 || html.length > MAX_PAGE_BYTES) return null;

    return { html, finalUrl: res.url || rawUrl };
  } catch {
    // Dead link, timeout, DNS failure, TLS error — all just mean "use the
    // bookmarklet".
    return null;
  }
}
