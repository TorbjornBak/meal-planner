// Tests for the rate-limiting arithmetic and the table of numbers (§9, Phase
// 6). Run with `npm test`.
//
// Everything in src/lib/rateLimitPolicy.ts is a total function of its
// arguments, which is why it is a separate module from the counting in
// src/lib/rateLimit.ts: the parts of a rate limit that are easy to get subtly
// wrong — the off-by-one at the limit, the window boundary, a Retry-After of
// zero, two spellings of one IP address becoming two buckets — are all
// arithmetic, and none of them should need Postgres to check.
//
// The database-backed half (that the increment is atomic, and that two
// requests racing at the boundary produce one allow and one refusal) is in
// src/lib/rateLimit.integration.test.mjs.

import test from "node:test";
import assert from "node:assert/strict";

import {
  LIMITS,
  clientIp,
  decide,
  windowExpiresAt,
  windowStartAt,
} from "./rateLimitPolicy.ts";

const MINUTE = 60 * 1000;

// --- the table -----------------------------------------------------------

test("every limit admits at least one attempt over a positive window", () => {
  for (const [name, limit] of Object.entries(LIMITS)) {
    assert.ok(limit.max >= 1, `${name} would refuse the first attempt`);
    assert.ok(limit.windowMs > 0, `${name} has no window`);
  }
});

test("the sensitive endpoints are keyed by both address and account", () => {
  // The point of the pair. An IP-only limit is beaten by a botnet against one
  // account; an account-only limit lets one host walk an address list a guess
  // at a time, and lets somebody lock a neighbour out on purpose. Losing
  // either half of a pair is a silent regression, so the pairing itself is
  // asserted rather than left to the routes to remember.
  for (const base of ["login", "password-forgot", "invitation:accept", "invitation:issue"]) {
    assert.ok(`${base}:ip` in LIMITS, `${base} has no per-address limit`);
    assert.ok(`${base}:email` in LIMITS, `${base} has no per-account limit`);
  }
});

test("the account key is at least as tight as the address key", () => {
  // An account limit looser than the address limit would never be the one that
  // trips, which makes it decoration.
  for (const base of ["login", "password-forgot", "invitation:accept", "invitation:issue"]) {
    assert.ok(
      LIMITS[`${base}:email`].max <= LIMITS[`${base}:ip`].max,
      `${base}:email is looser than ${base}:ip and can never bind`,
    );
  }
});

test("every endpoint that can send mail has an address limit", () => {
  for (const base of ["password-forgot", "invitation:issue", "newsletter-send"]) {
    assert.ok(`${base}:ip` in LIMITS, `${base} has no per-address limit`);
  }
});

// --- windows -------------------------------------------------------------

test("windows are anchored to the clock, not to first contact", () => {
  // Two callers knocking 30 seconds apart must land in the same window, or the
  // counter could not be keyed by it and every request would need a read
  // before its write.
  const first = windowStartAt(Date.parse("2026-08-31T10:07:13.000Z"), 15 * MINUTE);
  const second = windowStartAt(Date.parse("2026-08-31T10:07:43.000Z"), 15 * MINUTE);
  assert.equal(first.getTime(), second.getTime());
  assert.equal(first.toISOString(), "2026-08-31T10:00:00.000Z");
});

test("a window rolls over exactly on its boundary", () => {
  const window = 15 * MINUTE;
  const before = windowStartAt(Date.parse("2026-08-31T10:14:59.999Z"), window);
  const after = windowStartAt(Date.parse("2026-08-31T10:15:00.000Z"), window);
  assert.equal(before.toISOString(), "2026-08-31T10:00:00.000Z");
  assert.equal(after.toISOString(), "2026-08-31T10:15:00.000Z");
});

test("a row expires when its window ends", () => {
  const start = windowStartAt(Date.parse("2026-08-31T10:07:00.000Z"), 15 * MINUTE);
  assert.equal(windowExpiresAt(start, 15 * MINUTE).toISOString(), "2026-08-31T10:15:00.000Z");
});

// --- the decision --------------------------------------------------------

const LIMIT = { max: 3, windowMs: 15 * MINUTE };
const START = windowStartAt(Date.parse("2026-08-31T10:00:00.000Z"), LIMIT.windowMs);
const NOW = Date.parse("2026-08-31T10:05:00.000Z");

test("a limit of three admits exactly three attempts", () => {
  // `count` arrives post-increment, so the first attempt is 1. Getting this
  // boundary wrong by one is the classic way a limit of three becomes a limit
  // of two and starts refusing people who have done nothing wrong.
  assert.equal(decide(1, LIMIT, NOW, START).allowed, true);
  assert.equal(decide(3, LIMIT, NOW, START).allowed, true);
  assert.equal(decide(4, LIMIT, NOW, START).allowed, false);
});

test("remaining counts down and stops at zero", () => {
  assert.equal(decide(1, LIMIT, NOW, START).remaining, 2);
  assert.equal(decide(3, LIMIT, NOW, START).remaining, 0);
  assert.equal(decide(9, LIMIT, NOW, START).remaining, 0);
});

test("retry-after is the time left in the window", () => {
  assert.equal(decide(4, LIMIT, NOW, START).retryAfterSeconds, 600);
});

test("retry-after is never zero, even at the last instant of a window", () => {
  // A Retry-After of 0 tells a well-behaved client to try again immediately,
  // which is the one thing the header exists to prevent.
  const lastInstant = START.getTime() + LIMIT.windowMs;
  assert.equal(decide(4, LIMIT, lastInstant, START).retryAfterSeconds, 1);
});

// --- attributing a request to an address ---------------------------------

test("the client address is the hop nearest us, not the one the client claimed", () => {
  // The leftmost entry is whatever the caller wrote in the header, and is
  // worth nothing. Trusting it would let anybody reset their own limit by
  // inventing a new address per request.
  assert.equal(clientIp(headers({ "x-forwarded-for": "1.2.3.4, 203.0.113.9" })), "203.0.113.9");
});

test("a single-entry forwarded-for is used as it stands", () => {
  assert.equal(clientIp(headers({ "x-forwarded-for": "203.0.113.9" })), "203.0.113.9");
});

test("x-real-ip is the fallback when there is no forwarded-for", () => {
  assert.equal(clientIp(headers({ "x-real-ip": "203.0.113.9" })), "203.0.113.9");
});

test("one host written four ways is one bucket", () => {
  // Ports, brackets and IPv4-mapped IPv6 are all spellings a proxy might use.
  // Four spellings would otherwise be four buckets, and the limit four times
  // as loose as it reads.
  assert.equal(clientIp(headers({ "x-forwarded-for": "203.0.113.9:51234" })), "203.0.113.9");
  assert.equal(clientIp(headers({ "x-forwarded-for": "::ffff:203.0.113.9" })), "203.0.113.9");
  assert.equal(clientIp(headers({ "x-forwarded-for": "[2001:db8::1]:443" })), "2001:db8::1");
  assert.equal(clientIp(headers({ "x-forwarded-for": "[2001:DB8::1]" })), "2001:db8::1");
});

test("an unattributable request yields null rather than a shared bucket", () => {
  // The caller decides what this means. Folding every anonymous request into
  // one bucket would hand any single caller a way to lock out everybody else.
  assert.equal(clientIp(headers({})), null);
  assert.equal(clientIp(headers({ "x-forwarded-for": "  ,  " })), null);
});

function headers(map) {
  return { get: (name) => map[name] ?? null };
}
