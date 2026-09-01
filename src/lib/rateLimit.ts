/**
 * Counting attempts, and refusing when there have been too many (§9, Phase 6).
 *
 * The half of rate limiting that needs Postgres. The table of numbers and the
 * arithmetic live in src/lib/rateLimitPolicy.ts, where they can be tested
 * without one; this file does the increment, the decision, and the response.
 *
 * Counters are rows rather than a map in the process because the limit has to
 * outlive the thing it is protecting against. This app restarts on every push
 * and on every reboot of the box, and an in-memory counter forgets everything
 * each time — a guessing run that can simply wait, or that arrives during a
 * deploy, never meets a limit at all. Rows also mean one limit rather than one
 * per worker, which is what "persistent rate limits" in the plan is asking for.
 */

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { recordAudit } from "@/lib/audit";
import {
  LIMITS,
  type LimitName,
  decide,
  throttleDetail,
  windowExpiresAt,
  windowStartAt,
} from "@/lib/rateLimitPolicy";

/**
 * How a subject is written down.
 *
 * Never in the clear. The two things this table is keyed by are exactly the
 * two worth not accumulating: the address somebody is sitting behind, and the
 * email they typed into a login form — including every address that turned out
 * not to exist, which is to say a list of other people's mailboxes gathered by
 * whoever was probing. A keyed digest counts precisely as well as the value
 * would, and leaves a table that says nothing about who was here.
 *
 * Keyed with AUTH_SECRET rather than a bare SHA-256, because the input domain
 * is small enough to enumerate: a plain hash of an email address is an email
 * address to anybody holding a list of them.
 *
 * The HMAC is spelled out here rather than borrowed from src/lib/auth.ts to
 * keep that module's exported surface about sessions and links. It is six
 * lines, and sharing them would mean auth.ts exporting a general-purpose
 * "hash this with the app secret", which is an invitation to use it for things
 * that ought to have their own domain separation.
 */
async function digest(bucket: LimitName, value: string): Promise<string> {
  const secret = process.env.AUTH_SECRET;
  if (!secret) throw new Error("AUTH_SECRET is not set");

  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  // The bucket is inside the digest, so the same address in two limits is two
  // unrelated values and no row can be correlated across buckets.
  const signature = await crypto.subtle.sign("HMAC", key, enc.encode(`ratelimit:${bucket}:${value}`));
  return Array.from(new Uint8Array(signature))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * How often the sweep runs, as a probability per call. Expired rows are the
 * limiter's own litter, and a scheduler for them would be a third timer in
 * instrumentation.ts to explain and to watch. One in fifty calls deleting
 * what has expired keeps the table proportional to live traffic and costs an
 * indexed delete on a couple of percent of requests.
 */
const SWEEP_CHANCE = 0.02;

export interface Refusal {
  /** Which key ran out — useful in the log line, not in the response body. */
  bucket: LimitName;
  retryAfterSeconds: number;
}

/**
 * Count one attempt against one limit, and say whether it may proceed.
 *
 * The increment is a single upsert keyed on (bucket, subject, windowStart),
 * with the window start computed from the clock rather than from first
 * contact, so concurrent requests contend on one row instead of each creating
 * their own. Deciding on the post-increment count — rather than reading, then
 * comparing, then writing — is what makes two simultaneous attempts at the
 * boundary produce one allow and one refusal rather than two allows.
 *
 * A failure to count is a failure to allow. If Postgres is unreachable the
 * whole app is already broken, but the direction to be broken in is refusing
 * knocks rather than admitting unlimited ones.
 */
export async function consume(
  bucket: LimitName,
  subject: string,
): Promise<{ allowed: boolean; retryAfterSeconds: number }> {
  const limit = LIMITS[bucket];
  const now = Date.now();
  const windowStart = windowStartAt(now, limit.windowMs);
  const key = await digest(bucket, subject);

  const row = await prisma.rateLimitCounter.upsert({
    where: { bucket_subject_windowStart: { bucket, subject: key, windowStart } },
    create: {
      bucket,
      subject: key,
      windowStart,
      count: 1,
      expiresAt: windowExpiresAt(windowStart, limit.windowMs),
    },
    update: { count: { increment: 1 } },
    select: { count: true },
  });

  if (Math.random() < SWEEP_CHANCE) void sweep();

  const verdict = decide(row.count, limit, now, windowStart);
  return { allowed: verdict.allowed, retryAfterSeconds: verdict.retryAfterSeconds };
}

/** Drop windows that have rolled over. Best-effort; never fails a request. */
async function sweep(): Promise<void> {
  try {
    await prisma.rateLimitCounter.deleteMany({ where: { expiresAt: { lt: new Date() } } });
  } catch (error) {
    console.error("[ratelimit] sweep failed", error);
  }
}

/**
 * Count one attempt against several limits at once, and refuse if any is out.
 *
 * The sensitive endpoints are keyed by both the caller's address and the
 * account they named, and every one of them must count both keys on every
 * attempt — counting only until the first refusal would let an attacker keep
 * one bucket topped up in order to shield another. So all of them are consumed
 * before any verdict is read, and the refusal reported is the one with the
 * longest wait.
 *
 * Keys with a null value — a request with no attributable address — are
 * skipped rather than folded into a shared bucket, because one shared bucket
 * is a way for any caller to lock out every other. The remaining keys still
 * apply, and on this deployment there is always a proxy supplying an address.
 */
export async function consumeAll(
  keys: ReadonlyArray<readonly [LimitName, string | null | undefined]>,
): Promise<Refusal | null> {
  const applicable = keys.filter((k): k is [LimitName, string] => Boolean(k[1]));

  const outcomes = await Promise.all(
    applicable.map(async ([bucket, subject]) => ({ bucket, ...(await consume(bucket, subject)) })),
  );

  const refusals = outcomes.filter((o) => !o.allowed);
  if (refusals.length === 0) return null;

  refusals.sort((a, b) => b.retryAfterSeconds - a.retryAfterSeconds);
  return { bucket: refusals[0].bucket, retryAfterSeconds: refusals[0].retryAfterSeconds };
}

/**
 * The response a refused caller gets.
 *
 * Deliberately uninformative. It says how long to wait, because that is what a
 * person who has genuinely mistyped their password four times needs in order
 * to stop trying, and it says nothing about *which* key ran out — "you have
 * exhausted the attempts for this email address" would confirm that the
 * address exists, undoing on the throttle what §9 is careful about on the
 * login and forgot-password responses themselves.
 */
export function tooManyRequests(refusal: Refusal): NextResponse {
  return NextResponse.json(
    { error: "too-many-requests", retryAfter: refusal.retryAfterSeconds },
    { status: 429, headers: { "Retry-After": String(refusal.retryAfterSeconds) } },
  );
}

/**
 * A short, stable stand-in for a throttled subject, safe to put in a
 * human-readable audit sentence or use as a dedup key — never the address
 * itself.
 *
 * Built from the same AUTH_SECRET-keyed digest as the counter table above,
 * rather than a second scheme invented for this one call site: it's the same
 * property that makes that table safe to keep — two different subjects still
 * produce two different fingerprints, so "the same address tripped this
 * bucket three times" stays distinguishable from "three different addresses
 * did," but nothing here is invertible back to what was typed. Truncated to
 * 12 hex characters because this is read by a person skimming a sentence, not
 * compared byte-for-byte — the full 32-byte HMAC would be noise there.
 */
export async function throttleFingerprint(
  bucket: LimitName,
  subject: string | null,
): Promise<string | null> {
  if (subject === null) return null;
  return (await digest(bucket, subject)).slice(0, 12);
}

/** Record at most one AUTH_THROTTLED event per subject and fixed window. */
export async function recordThrottleOnce(opts: {
  bucket: LimitName;
  subject: string | null;
}): Promise<void> {
  const fingerprint = await throttleFingerprint(opts.bucket, opts.subject);
  const detail = throttleDetail(opts.bucket, fingerprint);
  const windowStart = windowStartAt(Date.now(), LIMITS[opts.bucket].windowMs);
  const already = await prisma.auditEvent.findFirst({
    where: { action: "AUTH_THROTTLED", detail, createdAt: { gte: windowStart } },
    select: { id: true },
  });
  if (already) return;

  await recordAudit({
    action: "AUTH_THROTTLED",
    // Never the plaintext subject here, even for an ":email" bucket. The
    // counter table above is keyed by an HMAC specifically so this
    // installation never accumulates the addresses somebody typed at a login
    // form — including every address that turned out not to exist, which is
    // to say a list of other people's mailboxes gathered by whoever was
    // probing. Writing the same value into subjectEmail the moment it's
    // throttled would undo that for exactly the addresses an attacker chose.
    // `detail` above carries the fingerprint instead, which is enough to see
    // that a throttle fired and in which bucket — the point of the row —
    // without the row becoming a second copy of the thing the counter table
    // was built not to keep.
    //
    // This is unlike AuditEvent.subjectEmail's other writers (invitation and
    // membership events): there, subjectEmail names someone the actor —
    // a signed-in admin acting on purpose — already knew by address, not
    // someone an unauthenticated caller merely typed at a form.
    subjectEmail: null,
    detail,
  });
}
