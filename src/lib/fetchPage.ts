/**
 * Fetching a recipe *page* from the open web — the paste-a-URL import path.
 *
 * This is the fast path in §1: instead of the bookmarklet sending page HTML
 * from your browser, the server fetches it given a URL you paste. It reuses the
 * same private-network guard as the image fetch
 * (`resolvePublicUrl`) so a pasted URL can't be used to probe the host's own
 * network, and caps the response so a giant page can't exhaust memory.
 *
 * Best-effort by design: many sites (bot protection, JS-only rendering, login
 * walls) won't yield a recipe to a plain server fetch. Every failure returns
 * null so the caller can fall back to the bookmarklet, which always works
 * because it's your real, logged-in browser.
 */

import { resolvePublicUrl } from "./image";

/** Recipe pages are large (400–500 KB seen in the wild); cap generously. */
const MAX_PAGE_BYTES = 5_000_000;

export interface FetchedPage {
  html: string;
  /** The URL after any redirects — a better source link than what was pasted. */
  finalUrl: string;
}

export async function fetchPageHtml(rawUrl: string): Promise<FetchedPage | null> {
  const url = resolvePublicUrl(rawUrl);
  if (!url) return null;

  try {
    const res = await fetch(url, {
      redirect: "follow",
      signal: AbortSignal.timeout(15_000),
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
    if (!res.ok) return null;

    // Only parse actual HTML — a redirect to a PDF/JSON/image isn't a recipe
    // page, and reading it as text would just produce garbage.
    const ctype = res.headers.get("content-type") ?? "";
    if (!/text\/html|application\/xhtml/i.test(ctype)) return null;

    const declared = Number(res.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > MAX_PAGE_BYTES) return null;

    const html = await res.text();
    if (html.length === 0 || html.length > MAX_PAGE_BYTES) return null;

    return { html, finalUrl: res.url || url };
  } catch {
    // Dead link, timeout, DNS failure, TLS error — all just mean "use the
    // bookmarklet".
    return null;
  }
}
