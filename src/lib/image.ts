/**
 * Getting a recipe photo into the database.
 *
 * Recipes are captured from pages you're already reading, and those pages
 * advertise their photo in their metadata (see `extractRecipeImageUrl`). We
 * download that one image and store the bytes ourselves rather than hotlinking:
 * the app has to work offline over Tailscale (§10), and a hotlinked photo dies
 * the day the source site reorganizes.
 *
 * This is the *only* place the server fetches anything from the open web, and
 * it fetches a single image by URL — not the recipe page. Recipe content still
 * arrives from your browser (§1, "no web scraping").
 */

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
 * Resolve a possibly-relative URL against the page it came from.
 * Returns null for anything that isn't a plain http(s) URL we're willing to
 * fetch — including private-network addresses, so a malicious recipe page
 * can't use the capture endpoint to probe the host's own network.
 */
export function resolvePublicUrl(raw: string, pageUrl?: string | null): string | null {
  let url: URL;
  try {
    url = new URL(raw, pageUrl ?? undefined);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (isPrivateHost(url.hostname)) return null;
  return url.toString();
}

function isPrivateHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".internal")) {
    return true;
  }
  if (h === "::1" || h.startsWith("fc") || h.startsWith("fd")) return true;

  const v4 = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!v4) return false;
  const [a, b] = [Number(v4[1]), Number(v4[2])];
  return (
    a === 0 ||
    a === 127 ||
    a === 10 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168)
  );
}

/**
 * Download an image, or return null if anything at all goes wrong — a dead
 * link, a redirect to an HTML error page, an oversized file, a slow host.
 * Every caller treats the photo as optional, so failure is never an error.
 */
export async function fetchImage(url: string): Promise<FetchedImage | null> {
  try {
    const res = await fetch(url, {
      redirect: "follow",
      signal: AbortSignal.timeout(10_000),
      headers: {
        // Some CDNs serve a 403 to clients that send no User-Agent at all.
        "user-agent": "MealPlanner/1.0 (household recipe app)",
        accept: "image/*",
      },
    });
    if (!res.ok) return null;

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

/** The bare type from a Content-Type header, if it's an image we accept. */
export function normalizeMime(header: string | null): string | null {
  if (!header) return null;
  const mime = header.split(";")[0].trim().toLowerCase();
  return ALLOWED_MIME.has(mime) ? mime : null;
}
