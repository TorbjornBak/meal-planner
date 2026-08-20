/**
 * Per-user sessions and emailed one-time tokens (§9).
 *
 * Accounts gate sign-in; they do not partition data. Every member sees the
 * same plan, library and ledger — the household model is unchanged, it just
 * has names and email addresses attached now.
 *
 * Sessions live in the database rather than in a self-contained signed cookie
 * so that signing out, or removing a member, takes effect on the next request
 * instead of whenever the cookie happens to expire.
 *
 * Crypto here is the Web Crypto API (not node:crypto) so this module runs
 * unchanged in middleware and in route handlers. Password hashing needs
 * node:crypto and lives in src/lib/password.ts.
 */

import { prisma } from "@/lib/prisma";
import type { AuthTokenPurpose, User } from "@prisma/client";

export const SESSION_COOKIE = "mp_session";

/** How long a session lasts, and how far each request pushes it out. */
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Only slide the expiry when it's moved by more than a day. Without this every
 * request would write to Session, turning a read-only page load into a write.
 */
const SLIDE_THRESHOLD_MS = 24 * 60 * 60 * 1000;

/** Lifetimes of the emailed links. Invitations are generous; resets are not. */
export const RESET_TTL_MS = 60 * 60 * 1000;
export const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

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

function toHex(buf: ArrayBuffer): string {
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
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
  return toHex(await crypto.subtle.sign("HMAC", key, enc.encode(message)));
}

// -----------------------------------------------------------------------------
// Tokens
// -----------------------------------------------------------------------------

/** A fresh 256-bit URL-safe token. This is the only time the raw value exists. */
export function generateToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/**
 * What we actually store. Session cookies and emailed links are bearer
 * credentials, so the database holds only a hash — a leaked dump doesn't hand
 * over live sessions or unexpired reset links.
 */
export async function hashToken(raw: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(raw));
  return toHex(digest);
}

// -----------------------------------------------------------------------------
// Sessions
// -----------------------------------------------------------------------------

/** Cookie attributes shared by the routes that set and clear the session. */
export function sessionCookieOptions(maxAgeSeconds: number) {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    // Served over HTTPS by `tailscale serve` (§10). Relaxed on plain-HTTP
    // localhost so `npm run dev` can hold a session.
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: maxAgeSeconds,
  };
}

export const SESSION_MAX_AGE_SECONDS = Math.floor(SESSION_TTL_MS / 1000);

/** Open a session for a user and return the raw cookie value to hand back. */
export async function createSession(userId: string): Promise<string> {
  const raw = generateToken();
  await prisma.session.create({
    data: {
      tokenHash: await hashToken(raw),
      userId,
      expiresAt: new Date(Date.now() + SESSION_TTL_MS),
    },
  });
  return raw;
}

/**
 * Resolve a cookie value to the signed-in user, or null.
 *
 * Expired rows are deleted on sight rather than left for a sweep, so an
 * expired cookie cleans up after itself.
 */
export async function getSessionUser(raw: string | undefined): Promise<User | null> {
  if (!raw) return null;

  const session = await prisma.session.findUnique({
    where: { tokenHash: await hashToken(raw) },
    include: { user: true },
  });
  if (!session) return null;

  if (session.expiresAt.getTime() <= Date.now()) {
    await prisma.session.delete({ where: { id: session.id } }).catch(() => {});
    return null;
  }

  const nextExpiry = new Date(Date.now() + SESSION_TTL_MS);
  if (nextExpiry.getTime() - session.expiresAt.getTime() > SLIDE_THRESHOLD_MS) {
    await prisma.session
      .update({
        where: { id: session.id },
        data: { expiresAt: nextExpiry, lastSeenAt: new Date() },
      })
      .catch(() => {});
  }

  return session.user;
}

/** Sign out one browser. Unknown tokens are a no-op, not an error. */
export async function destroySession(raw: string | undefined): Promise<void> {
  if (!raw) return;
  await prisma.session.deleteMany({ where: { tokenHash: await hashToken(raw) } });
}

/** Sign out everywhere. Used after a password change or reset. */
export async function destroyAllSessions(userId: string): Promise<void> {
  await prisma.session.deleteMany({ where: { userId } });
}

// -----------------------------------------------------------------------------
// Emailed one-time links
// -----------------------------------------------------------------------------

/**
 * Mint a single-use link token. Any unused token of the same purpose is
 * dropped first, so hitting "forgot password" twice leaves exactly one live
 * link — the newest one.
 */
export async function issueAuthToken(
  userId: string,
  purpose: AuthTokenPurpose,
  ttlMs: number,
): Promise<string> {
  await prisma.authToken.deleteMany({ where: { userId, purpose, usedAt: null } });
  const raw = generateToken();
  await prisma.authToken.create({
    data: {
      tokenHash: await hashToken(raw),
      userId,
      purpose,
      expiresAt: new Date(Date.now() + ttlMs),
    },
  });
  return raw;
}

/**
 * Look a link token up without spending it — for rendering the reset page
 * before the new password has been typed.
 */
export async function peekAuthToken(
  raw: string,
  purpose: AuthTokenPurpose,
): Promise<User | null> {
  const token = await prisma.authToken.findUnique({
    where: { tokenHash: await hashToken(raw) },
    include: { user: true },
  });
  if (!token || token.purpose !== purpose) return null;
  if (token.usedAt || token.expiresAt.getTime() <= Date.now()) return null;
  return token.user;
}

/**
 * Spend a link token, returning the user it belonged to.
 *
 * The `updateMany` filtered on `usedAt: null` is the atomic step: two requests
 * racing on the same link produce one winner and one null, so a token can't be
 * redeemed twice.
 */
export async function redeemAuthToken(
  raw: string,
  purpose: AuthTokenPurpose,
): Promise<User | null> {
  const tokenHash = await hashToken(raw);
  const token = await prisma.authToken.findUnique({ where: { tokenHash } });
  if (!token || token.purpose !== purpose) return null;
  if (token.expiresAt.getTime() <= Date.now()) return null;

  const claimed = await prisma.authToken.updateMany({
    where: { id: token.id, usedAt: null },
    data: { usedAt: new Date() },
  });
  if (claimed.count !== 1) return null;

  return prisma.user.findUnique({ where: { id: token.userId } });
}

// -----------------------------------------------------------------------------
// Derived household tokens
// -----------------------------------------------------------------------------

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

/**
 * The one-click unsubscribe token in every newsletter footer (§9b). Derived
 * from AUTH_SECRET and the user id rather than stored, so an unsubscribe link
 * keeps working for as long as the account does and costs no table.
 */
export function unsubscribeToken(userId: string): Promise<string> {
  return hmacHex(`unsubscribe:${userId}`);
}

export async function isValidUnsubscribeToken(
  userId: string,
  token: string | undefined,
): Promise<boolean> {
  if (!token) return false;
  return safeEqual(token, await unsubscribeToken(userId));
}

// -----------------------------------------------------------------------------
// Bootstrap
// -----------------------------------------------------------------------------

/**
 * Whether the instance has no accounts yet.
 *
 * A fresh deployment has nobody who could sign in and nobody who could invite,
 * so /setup is opened up until the first account exists (§9).
 */
export async function needsSetup(): Promise<boolean> {
  return (await prisma.user.count()) === 0;
}

/** Emails are compared and stored lowercased; users capitalise inconsistently. */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * Good enough to catch a typo before we hand the address to the SMTP server,
 * which is the real authority on deliverability.
 */
export function looksLikeEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/.test(email);
}
