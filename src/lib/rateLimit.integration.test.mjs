// End-to-end tests of the rate-limit counter (§9, Phase 6). Run with
// `npm test`, against a real Postgres.
//
// src/lib/rateLimitPolicy.ts is pure and tested exhaustively in
// src/lib/rateLimitPolicy.test.mjs; this file is the other half — the claim
// that the increment in src/lib/rateLimit.ts is atomic, and therefore that a
// limit of five admits exactly five attempts no matter how they arrive. That
// claim is the whole reason the counter is a database row keyed by
// (bucket, subject, windowStart) and incremented with one upsert rather than
// a read followed by a write, and it only means anything under real
// concurrency against a real database. Asserting it against a mock would test
// a copy of the logic instead of the logic.
//
// It needs a reachable DATABASE_URL and skips itself without one, so a laptop
// with no Postgres running still gets a green `npm test`. Every test uses a
// unique subject and cleans up in `t.after`, so the file is safe to run twice
// in a row against the same database.
//
// The module-resolution hook below is the same device as
// src/lib/invitations.integration.test.mjs: src/lib/rateLimit.ts reaches
// Prisma through the `@/` path alias, which only Next.js and `tsc` know how to
// resolve, so the hook rewrites `@/x` to src/x.ts before anything is imported.
//
// It carries one extra rewrite that file does not need. rateLimit.ts also
// imports `next/server`, for the 429 it hands back, and Node's ESM resolver
// will not take that bare specifier without the `.js` the package actually
// ships. The alternative was to move `tooManyRequests` into a module of its
// own so nothing under test touches Next at all — worth doing if this spreads,
// but a second module and a second import in every route is a lot of ceremony
// to buy one line of test setup.

import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import path from "node:path";
import { randomUUID } from "node:crypto";

// The limiter hashes its subjects with AUTH_SECRET, so a developer running
// just this file against a scratch database shouldn't have to know that first.
process.env.AUTH_SECRET ??= "ratelimit-integration-test-secret-do-not-use-elsewhere";

const SRC = path.resolve(import.meta.dirname, "..");

const resolveAliasHook = `
  import path from "node:path";
  import { pathToFileURL } from "node:url";
  const SRC = ${JSON.stringify(SRC)};
  export async function resolve(specifier, context, nextResolve) {
    if (specifier.startsWith("@/")) {
      const target = pathToFileURL(path.join(SRC, specifier.slice(2) + ".ts")).href;
      return nextResolve(target, context);
    }
    if (specifier === "next/server") {
      return nextResolve("next/server.js", context);
    }
    return nextResolve(specifier, context);
  }
`;
register(`data:text/javascript,${encodeURIComponent(resolveAliasHook)}`, import.meta.url);

const { prisma } = await import("@/lib/prisma");
const { consume, consumeAll } = await import("@/lib/rateLimit");
const { LIMITS } = await import("./rateLimitPolicy.ts");

/**
 * Whether there is a database to test against, checked once at module load —
 * the same shape as src/lib/invitations.integration.test.mjs, so a missing
 * dependency reads the same way everywhere in this test suite.
 */
async function findSkipReason() {
  if (!process.env.DATABASE_URL) return "DATABASE_URL is not set";
  try {
    await Promise.race([
      prisma.$queryRaw`SELECT 1`,
      new Promise((_resolve, reject) =>
        setTimeout(() => reject(new Error("connection timed out")), 5000),
      ),
    ]);
    return false;
  } catch (err) {
    return `no Postgres reachable at DATABASE_URL (${err instanceof Error ? err.message : String(err)})`;
  }
}

const SKIP = await findSkipReason();

/** A subject nothing else in the suite will collide with. */
function uniqueSubject(label) {
  return `${label}-${randomUUID()}`;
}

/**
 * Rows for one subject, across every bucket. Subjects are stored as a keyed
 * digest, so a test cannot find its own rows by value — it counts what it
 * created by draining the bucket instead, and cleans up by expiry sweep.
 */
async function dropAll() {
  await prisma.rateLimitCounter.deleteMany({});
}

// --- The basic contract ---------------------------------------------------

test("a limit of five admits exactly five attempts, then refuses", { skip: SKIP }, async (t) => {
  t.after(dropAll);

  const subject = uniqueSubject("basic");
  const limit = LIMITS["login:email"];

  for (let i = 1; i <= limit.max; i++) {
    const { allowed } = await consume("login:email", subject);
    assert.equal(allowed, true, `attempt ${i} of ${limit.max} should have been allowed`);
  }

  const overflow = await consume("login:email", subject);
  assert.equal(overflow.allowed, false);
  assert.ok(overflow.retryAfterSeconds > 0, "a refusal must say how long to wait");
});

test("two subjects in one bucket are counted separately", { skip: SKIP }, async (t) => {
  t.after(dropAll);

  const mine = uniqueSubject("mine");
  const theirs = uniqueSubject("theirs");

  // Exhaust one subject completely.
  for (let i = 0; i < LIMITS["login:email"].max + 1; i++) await consume("login:email", mine);

  // The other must be untouched. If this fails, one person failing to log in
  // has locked out everybody else — the exact failure mode a shared bucket
  // would produce, and the reason clientIp returns null rather than a
  // catch-all string for unattributable requests.
  const { allowed } = await consume("login:email", theirs);
  assert.equal(allowed, true);
});

test("one subject in two buckets is two independent counters", { skip: SKIP }, async (t) => {
  t.after(dropAll);

  const subject = uniqueSubject("shared");
  for (let i = 0; i < LIMITS["login:email"].max + 1; i++) await consume("login:email", subject);

  // The digest includes the bucket name, so the same address exhausted for
  // sign-in has spent nothing of its forgot-password allowance.
  const { allowed } = await consume("password-forgot:email", subject);
  assert.equal(allowed, true);
});

// --- The claim the database is here for -----------------------------------

test(
  "attempts arriving together are counted exactly once each",
  { skip: SKIP },
  async (t) => {
    t.after(dropAll);

    // The reason the counter is a row and the increment is a single upsert.
    // A read-then-write limiter passes every sequential test above and fails
    // this one: twenty concurrent requests all read zero, all decide they are
    // under the limit, and all proceed. Here exactly `max` may be allowed.
    const subject = uniqueSubject("concurrent");
    const limit = LIMITS["login:ip"];
    const attempts = limit.max * 2;

    const outcomes = await Promise.all(
      Array.from({ length: attempts }, () => consume("login:ip", subject)),
    );

    const allowed = outcomes.filter((o) => o.allowed).length;
    assert.equal(
      allowed,
      limit.max,
      `${attempts} simultaneous attempts should have yielded exactly ${limit.max} allowances`,
    );
  },
);

test("a burst leaves one row, not one row per attempt", { skip: SKIP }, async (t) => {
  t.after(dropAll);

  // Contending on one row is what makes the counter cheap. If concurrent
  // upserts were instead creating a row apiece, every limit would be
  // effectively unlimited and the table would grow with the attack.
  const subject = uniqueSubject("onerow");
  await Promise.all(Array.from({ length: 8 }, () => consume("password-reset:ip", subject)));

  const rows = await prisma.rateLimitCounter.findMany({ where: { bucket: "password-reset:ip" } });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].count, 8);
});

// --- consumeAll -----------------------------------------------------------

test("consumeAll refuses when any one of its keys is exhausted", { skip: SKIP }, async (t) => {
  t.after(dropAll);

  const ip = uniqueSubject("ip");
  const email = uniqueSubject("email");

  // Drain the email key alone; the IP key is still well inside its allowance.
  for (let i = 0; i < LIMITS["login:email"].max; i++) await consume("login:email", email);

  const refusal = await consumeAll([
    ["login:ip", ip],
    ["login:email", email],
  ]);
  assert.ok(refusal, "an exhausted email key must refuse even when the address is fine");
  assert.equal(refusal.bucket, "login:email");
});

test("consumeAll counts every key, not just up to the first refusal", { skip: SKIP }, async (t) => {
  t.after(dropAll);

  // Counting lazily would let an attacker shield one bucket behind another:
  // keep the email key permanently exhausted and the IP key is never charged,
  // so the address limit never binds.
  const ip = uniqueSubject("ip");
  const email = uniqueSubject("email");
  for (let i = 0; i < LIMITS["login:email"].max + 1; i++) await consume("login:email", email);

  await consumeAll([
    ["login:ip", ip],
    ["login:email", email],
  ]);

  const rows = await prisma.rateLimitCounter.findMany({ where: { bucket: "login:ip" } });
  assert.equal(rows.length, 1, "the address key should have been charged despite the refusal");
  assert.equal(rows[0].count, 1);
});

test("consumeAll skips keys with no value rather than sharing a bucket", { skip: SKIP }, async (t) => {
  t.after(dropAll);

  // A request with no attributable address must not be folded in with every
  // other such request, which would hand any single caller a way to lock out
  // everybody else.
  const refusal = await consumeAll([
    ["login:ip", null],
    ["login:email", undefined],
  ]);
  assert.equal(refusal, null);
  assert.equal(await prisma.rateLimitCounter.count(), 0);
});
