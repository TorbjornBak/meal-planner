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
import type { AuthTokenPurpose, HouseholdRole, User } from "@prisma/client";
import { recordAudit } from "@/lib/audit";
import { LIMITS, type LimitName, windowStartAt } from "@/lib/rateLimitPolicy";

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
    // Served over HTTPS by `tailscale serve` (§10). Relaxed on plain-HTTP
    // localhost so `npm run dev` can hold a session.
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
 * without one. Derived from AUTH_SECRET, so it's stable and needs no storage.
 */
export function captureToken(householdId: string): Promise<string> {
  return hmacHex(`capture:${householdId}`);
}

export async function isValidCaptureToken(
  householdId: string | undefined,
  token: string | undefined,
): Promise<boolean> {
  if (!householdId || !token) return false;
  return safeEqual(token, await captureToken(householdId));
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

// -----------------------------------------------------------------------------
// Rate-limit auditing
// -----------------------------------------------------------------------------

/**
 * The sentence written to AuditEvent when a limiter refuses a public request,
 * and — because it is deterministic in (bucket, subject) — also the value
 * recordThrottleOnce matches against to decide whether it has already written
 * one for this window (§9, Phase 6).
 *
 * Kept pure and separate from the write itself for the reason
 * rateLimitPolicy.ts is kept separate from rateLimit.ts: this is the part
 * worth checking word for word without a database, and here a typo doesn't
 * just read oddly on the admin screen, it silently breaks the dedup that
 * keeps a flood from writing one audit row per request.
 */
export function throttleDetail(bucket: LimitName, subject: string | null): string {
  const isEmailKey = bucket.endsWith(":email");
  const target = subject ?? (isEmailKey ? "an unrecorded address" : "an unattributed address");

  switch (bucket) {
    case "login:ip":
    case "login:email":
      return isEmailKey
        ? `Sign-in attempts against ${target} were throttled.`
        : `Sign-in attempts from ${target} were throttled.`;
    case "password-forgot:ip":
    case "password-forgot:email":
      return isEmailKey
        ? `Password-reset requests against ${target} were throttled.`
        : `Password-reset requests from ${target} were throttled.`;
    case "password-reset:ip":
      return `Password-reset submissions from ${target} were throttled.`;
    case "invitation:inspect:ip":
      return `Invitation-link views from ${target} were throttled.`;
    case "invitation:accept:ip":
    case "invitation:accept:email":
      return isEmailKey
        ? `Invitation acceptances against ${target} were throttled.`
        : `Invitation acceptances from ${target} were throttled.`;
    case "setup:ip":
      return `First-run setup attempts from ${target} were throttled.`;
    default:
      // Every other limit in the table (invitation issuance, an SMTP test, a
      // signed-in password change) is authenticated and never refuses an
      // anonymous caller, so nothing here needs to word it — this function
      // exists for the public routes in Phase 6's slice of the plan.
      return `Attempts against ${target} were throttled.`;
  }
}

/**
 * Record AUTH_THROTTLED the first time a limiter refuses a request in a given
 * window, and stay quiet for every refusal after that.
 *
 * consumeAll (src/lib/rateLimit.ts) reports only allow or refuse, on purpose:
 * the running count is the rate limiter's own business, and a route reading
 * it to make audit decisions would blur a boundary that is otherwise clean.
 * That leaves no cheap way to tell "the request that just tipped this bucket
 * over" from "the ten-thousandth request against a bucket that tipped over a
 * minute ago" by the numbers alone — and writing a row for every refusal
 * would turn a flood aimed at an already-closed door into a flood of audit
 * rows, which is exactly the write amplification the plan warns about.
 * Querying for a row already written for this bucket and subject inside the
 * current window is the alternative that doesn't need the count: it costs one
 * indexed read per refusal, and refusals are themselves already bounded by
 * the very limit that is doing the refusing.
 */
export async function recordThrottleOnce(opts: {
  bucket: LimitName;
  subject: string | null;
}): Promise<void> {
  const detail = throttleDetail(opts.bucket, opts.subject);
  const windowStart = windowStartAt(Date.now(), LIMITS[opts.bucket].windowMs);

  const already = await prisma.auditEvent.findFirst({
    where: { action: "AUTH_THROTTLED", detail, createdAt: { gte: windowStart } },
    select: { id: true },
  });
  if (already) return;

  await recordAudit({
    action: "AUTH_THROTTLED",
    subjectEmail: opts.bucket.endsWith(":email") ? opts.subject : null,
    detail,
  });
}
