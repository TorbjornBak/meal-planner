/**
 * What a receipt photo may be, on the way in and on the way out (§7, Phase 6).
 *
 * Receipt bytes are the one thing in this app that a member uploads and the
 * app later serves straight back from its own origin. That round trip is why
 * this module exists rather than a size constant sitting in a route: the
 * bytes are stored with a content type, and until Phase 6 that content type
 * was whatever the uploader's browser claimed — `photo.type`, unvalidated,
 * written to the database and handed back verbatim in a `Content-Type` header
 * by GET /api/trips/[id]/receipt.
 *
 * That is a stored cross-site-scripting hole, not merely untidiness. Upload a
 * file announcing itself as `text/html`, and opening the receipt URL renders
 * attacker-authored markup as a document on the app's own origin, with the
 * session cookie attached to every request it then makes. It needs an account
 * to plant, which on a one-household tailnet box made it nearly theoretical;
 * it stops being theoretical the moment two households who don't know each
 * other share an installation and the box is reachable from the open internet.
 *
 * So the type is checked against an allowlist at upload, and — because rows
 * written before this existed are still in the database — checked *again* on
 * the way out rather than trusted because it was stored.
 */

/**
 * Generous for a phone photo, small enough that a bad upload fails fast.
 *
 * The single source of this number. `next.config.mjs` raises the middleware
 * body envelope to 11 MB specifically so a 10 MB photo plus its multipart
 * framing survives the trip to the route handler — see
 * src/lib/receiptUpload.test.mjs, which asserts exactly that — so the two
 * numbers are a matched pair and moving one without the other silently breaks
 * uploads at the boundary.
 */
export const MAX_RECEIPT_PHOTO_BYTES = 10 * 1024 * 1024;

/**
 * Image types a phone camera actually produces, and that a browser renders
 * inline without help.
 *
 * Deliberately not "anything starting with `image/`". That test admits
 * `image/svg+xml`, which is a document format: an SVG can carry script, and
 * it is served inline, so allowing it would reopen the hole this module
 * closes by a side door. A receipt is a photograph; no camera has ever
 * produced one as SVG.
 */
const ALLOWED_RECEIPT_MIME = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/heic",
  "image/heif",
]);

/**
 * Why this upload is unacceptable, or null if it is fine.
 *
 * Returns a sentence rather than a boolean for the same reason
 * `passwordProblem` does: the caller turns it into a 4xx body, and the person
 * reading it needs to know which of the two rules they hit.
 */
export function receiptPhotoProblem(file: File): string | null {
  if (file.size === 0) return "that file is empty";
  if (file.size > MAX_RECEIPT_PHOTO_BYTES) {
    return `receipt photos are limited to ${Math.floor(MAX_RECEIPT_PHOTO_BYTES / (1024 * 1024))} MB`;
  }
  if (!isAllowedReceiptMime(file.type)) {
    return "a receipt photo has to be a JPEG, PNG, WebP or HEIC image";
  }
  return null;
}

/** The bare type, lowercased, without any `; charset=…` the browser added. */
function bareMime(raw: string | null | undefined): string {
  return (raw ?? "").split(";")[0].trim().toLowerCase();
}

export function isAllowedReceiptMime(raw: string | null | undefined): boolean {
  return ALLOWED_RECEIPT_MIME.has(bareMime(raw));
}

/**
 * The `Content-Type` to serve a stored receipt under.
 *
 * Checked rather than trusted, because the database holds rows written before
 * uploads were validated, and those carry whatever their uploader said. An
 * unrecognised type degrades to `application/octet-stream`, which browsers
 * download rather than render — the receipt is still retrievable, it simply
 * stops being a document the browser will execute. Falling back to a *refusal*
 * was the alternative, and it is worse: it would make a household's own
 * legitimately-odd historical receipt unreachable to punish a hypothetical.
 */
export function safeReceiptContentType(stored: string | null | undefined): string {
  return isAllowedReceiptMime(stored) ? bareMime(stored) : "application/octet-stream";
}
