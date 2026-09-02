/**
 * Per-user sessions and emailed one-time tokens (§9).
 *
 * Accounts gate sign-in; household memberships partition private data. A
 * session remembers which of the user's households the browser is acting in.
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
import type { AuthTokenPurpose, HouseholdRole, Prisma, User } from "@prisma/client";

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

/**
 * Whether an `Authorization: Bearer …` header carries the expected secret.
 *
 * For the endpoints a script calls rather than a browser: they have no cookie
 * jar, so they present a shared secret instead. An unset secret matches
 * nothing, so forgetting to configure one closes the endpoint rather than
 * opening it.
 */
export function bearerTokenMatches(header: string | null, secret: string | undefined): boolean {
  if (!secret) return false;
  const presented = header?.startsWith("Bearer ") ? header.slice(7) : "";
  return safeEqual(presented, secret);
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
    // Served over HTTPS by the deployment's TLS terminator (§10). Relaxed on
    // plain-HTTP localhost so `npm run dev` can hold a session.
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: maxAgeSeconds,
  };
}

export const SESSION_MAX_AGE_SECONDS = Math.floor(SESSION_TTL_MS / 1000);

async function membershipForUser(userId: string, householdId?: string) {
  if (householdId) {
    return prisma.householdMembership.findUnique({
      where: { householdId_userId: { householdId, userId } },
      include: { household: { select: { id: true, name: true } } },
    });
  }

  return prisma.householdMembership.findFirst({
    where: { userId },
    orderBy: [{ createdAt: "asc" }, { householdId: "asc" }],
    include: { household: { select: { id: true, name: true } } },
  });
}

/** Open a session for a user and return the raw cookie value to hand back. */
export async function createSession(userId: string, householdId?: string): Promise<string> {
  const raw = generateToken();
  const membership = await membershipForUser(userId, householdId);
  if (householdId && !membership) {
    throw new Error("user is not a member of the requested household");
  }

  await prisma.session.create({
    data: {
      tokenHash: await hashToken(raw),
      userId,
      activeHouseholdId: membership?.householdId,
      expiresAt: new Date(Date.now() + SESSION_TTL_MS),
    },
  });
  return raw;
}

type ResolvedSession = {
  id: string;
  userId: string;
  activeHouseholdId: string | null;
  user: User;
};

async function resolveSession(raw: string | undefined): Promise<ResolvedSession | null> {
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

  return session;
}

/**
 * Resolve a cookie value to the signed-in user, or null.
 *
 * Expired rows are deleted on sight rather than left for a sweep, so an
 * expired cookie cleans up after itself.
 */
export async function getSessionUser(raw: string | undefined): Promise<User | null> {
  return (await resolveSession(raw))?.user ?? null;
}

export type HouseholdSessionContext = {
  sessionId: string;
  user: User;
  household: { id: string; name: string };
  role: HouseholdRole;
};

/**
 * Resolve the session's selected household through membership.
 *
 * Old sessions created before active-household support are repaired lazily by
 * selecting the user's oldest membership. No membership means no household
 * context: the account may authenticate, but cannot reach private data.
 */
export async function getSessionHouseholdContext(
  raw: string | undefined,
): Promise<HouseholdSessionContext | null> {
  const session = await resolveSession(raw);
  if (!session) return null;

  const membership = await membershipForUser(
    session.userId,
    session.activeHouseholdId ?? undefined,
  );

  if (!membership) return null;

  if (session.activeHouseholdId !== membership.householdId) {
    await prisma.session.update({
      where: { id: session.id },
      data: { activeHouseholdId: membership.householdId },
    });
  }

  return {
    sessionId: session.id,
    user: session.user,
    household: membership.household,
    role: membership.role,
  };
}

/** Select another household for this browser, only if the user belongs to it. */
export async function selectSessionHousehold(
  raw: string | undefined,
  householdId: string,
): Promise<boolean> {
  const session = await resolveSession(raw);
  if (!session) return false;

  const membership = await prisma.householdMembership.findUnique({
    where: { householdId_userId: { householdId, userId: session.userId } },
    select: { householdId: true },
  });
  if (!membership) return false;

  await prisma.session.update({
    where: { id: session.id },
    data: { activeHouseholdId: membership.householdId },
  });
  return true;
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
 * without one.
 *
 * Derived from AUTH_SECRET *and* the household's stored `captureKey`, not
 * from AUTH_SECRET alone. A token that was a pure function of AUTH_SECRET and
 * the household id could never be revoked without rotating AUTH_SECRET, which
 * signs every account on the installation out — so a member removed from a
 * household kept a permanent write credential into it. Mixing in a
 * per-household value that rotateCaptureKey can rewrite on its own means
 * removing one member invalidates that household's bookmarklet without
 * touching anyone else's session.
 *
 * A household id that doesn't exist derives from an empty key rather than
 * throwing, so a bad id fails the safeEqual comparison in
 * isValidCaptureToken like any other wrong token, instead of every caller
 * needing to handle a throw for a household that isn't theirs to worry about.
 */
export async function captureToken(householdId: string): Promise<string> {
  const household = await prisma.household.findUnique({
    where: { id: householdId },
    select: { captureKey: true },
  });
  return hmacHex(`capture:${householdId}:${household?.captureKey ?? ""}`);
}

export async function isValidCaptureToken(
  householdId: string | undefined,
  token: string | undefined,
): Promise<boolean> {
  if (!householdId || !token) return false;
  return safeEqual(token, await captureToken(householdId));
}

/**
 * Rotate a household's capture-token salt (§1).
 *
 * Call this whenever somebody loses access to the household — a member is
 * removed, leaves by removing themselves, or a platform admin's membership
 * intervention takes them out — so every previously-issued bookmarklet for
 * the household stops authenticating immediately. This rotates the token for
 * *everyone* still in the household too, not just the person who left: there
 * is no way to invalidate one copy of a shared household credential without
 * invalidating all of them. That is the correct trade anyway — a stale
 * bookmarklet is an annoyance a remaining member notices and re-copies from
 * Settings once; a capture token still live in the hands of somebody who was
 * removed is a standing, unattended way to keep writing into a household's
 * recipe library forever.
 *
 * Takes an optional transaction client so the rotation can commit atomically
 * with the membership deletion that triggered it, which is what makes "the
 * membership is gone" and "the old token stops working" a single fact rather
 * than a window between two separate writes.
 */
export async function rotateCaptureKey(
  householdId: string,
  client: Prisma.TransactionClient | typeof prisma = prisma,
): Promise<void> {
  await client.household.update({
    where: { id: householdId },
    data: { captureKey: generateToken() },
  });
}

/**
 * The one-click unsubscribe token in every newsletter footer (§9b). Derived
 * from AUTH_SECRET, the user id and the household rather than stored, so an
 * unsubscribe link keeps working for as long as the membership does and costs
 * no table.
 *
 * The household is in the HMAC, not merely in the query string, because the
 * digest opt-in is per membership: a reader in two households who presses
 * their mail client's unsubscribe button means "stop *this* mail", and a token
 * that covered only the user id would let a link from one household silence
 * the other — or, worse, be edited in the URL bar to do so deliberately.
 */
export function unsubscribeToken(userId: string, householdId: string): Promise<string> {
  return hmacHex(`unsubscribe:${userId}:${householdId}`);
}

export async function isValidUnsubscribeToken(
  userId: string,
  householdId: string,
  token: string | undefined,
): Promise<boolean> {
  if (!token) return false;
  return safeEqual(token, await unsubscribeToken(userId, householdId));
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
