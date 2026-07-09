/**
 * Household shared-password auth (§9).
 *
 * No individual accounts — one shared password gates the whole app. This is
 * defense-in-depth behind Tailscale, not a full account system. On success we
 * set a signed cookie whose value is an HMAC over a fixed marker; any request
 * carrying a valid cookie is let through.
 *
 * Uses the Web Crypto API (not node:crypto) so it runs unchanged in both the
 * Edge middleware and Node route handlers.
 */

export const SESSION_COOKIE = "mp_session";

function secret(): string {
  const s = process.env.AUTH_SECRET;
  if (!s) throw new Error("AUTH_SECRET is not set");
  return s;
}

/** Length-checked constant-time string comparison. */
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

/** Constant-time comparison of a submitted password to the configured one. */
export function verifyPassword(submitted: string): boolean {
  return safeEqual(submitted, process.env.HOUSEHOLD_PASSWORD ?? "");
}

async function hmacHex(message: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret()),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(message));
  return Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** The value to store in the session cookie once the password checks out. */
export function issueSessionToken(): Promise<string> {
  return hmacHex("household");
}

/** Whether a cookie value is a valid, unforged session token. */
export async function isValidSession(token: string | undefined): Promise<boolean> {
  if (!token) return false;
  return safeEqual(token, await issueSessionToken());
}

/**
 * A stable household token for the bookmarklet capture endpoint (§1). Distinct
 * from the session cookie so the cross-origin capture request can authenticate
 * without one. Derived from AUTH_SECRET, so it's stable and needs no storage.
 */
export function captureToken(): Promise<string> {
  return hmacHex("capture");
}

export async function isValidCaptureToken(token: string | undefined): Promise<boolean> {
  if (!token) return false;
  return safeEqual(token, await captureToken());
}
