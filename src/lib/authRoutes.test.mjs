// Tests for the pure logic behind Phase 6's public-route rate limiting (§9,
// Phase 6). Run with `npm test`.
//
// throttleDetail is the pure wording logic beside the persistent limiter: a
// total function of its arguments — the sentence AUTH_THROTTLED records, and
// also the key recordThrottleOnce matches on to decide whether it has already
// written one for this window. Both jobs ride on the same string, so a
// regression here would silently break the dedup as much as the wording, and
// it is worth checking exhaustively rather than trusting a route to exercise
// every bucket.
//
// recordThrottleOnce itself needs Postgres for the "already written this
// window" check and is exercised for real in
// src/lib/rateLimit.integration.test.mjs's sibling suite once that table
// exists to query; this file covers the half that doesn't need one.
//
// The wording lives in the pure policy module, so this suite needs no database
// and no Next.js runtime.

import test from "node:test";
import assert from "node:assert/strict";
const { LIMITS, throttleDetail } = await import("./rateLimitPolicy.ts");

// --- coverage --------------------------------------------------------------

test("every limit this route slice actually uses has wording", () => {
  // The buckets Phase 6's public routes consume. If one of them fell through
  // to the generic "Attempts against …" sentence, the admin screen would read
  // as if the wording had simply been forgotten for that endpoint.
  const owned = [
    "login:ip",
    "login:email",
    "password-forgot:ip",
    "password-forgot:email",
    "password-reset:ip",
    "invitation:inspect:ip",
    "invitation:accept:ip",
    "invitation:accept:email",
    "setup:ip",
  ];
  for (const bucket of owned) {
    assert.ok(bucket in LIMITS, `${bucket} is missing from LIMITS`);
    assert.doesNotMatch(
      throttleDetail(bucket, "x"),
      /^Attempts /,
      `${bucket} fell through to the generic sentence`,
    );
  }
});

test("a bucket not owned by this slice still gets a sentence, generically", () => {
  // invitation:issue:user, mail-test:user and password-change:user are
  // authenticated limits that never refuse an anonymous caller, so nothing in
  // this slice needs to word them — but the function must not throw for a
  // LimitName it doesn't recognise, since LIMITS can grow.
  assert.equal(
    throttleDetail("invitation:issue:user", "someone@example.com"),
    "Attempts against someone@example.com were throttled.",
  );
});

// --- ip vs email framing -----------------------------------------------

test("an :ip bucket is worded 'from', not 'against'", () => {
  const detail = throttleDetail("login:ip", "203.0.113.9");
  assert.match(detail, /from 203\.0\.113\.9/);
  assert.doesNotMatch(detail, /against/);
});

test("an :email bucket is worded 'against', not 'from'", () => {
  const detail = throttleDetail("login:email", "person@example.com");
  assert.match(detail, /against person@example\.com/);
  assert.doesNotMatch(detail, /from person@example\.com/);
});

// --- the null subject, and why it can't collide with a real one --------

test("a null ip subject reads as unattributed, not as the word 'null'", () => {
  const detail = throttleDetail("login:ip", null);
  assert.match(detail, /from an unattributed address/);
});

test("a null email subject reads as unrecorded, not as the word 'null'", () => {
  const detail = throttleDetail("password-forgot:email", null);
  assert.match(detail, /against an unrecorded address/);
});

test("the ip and email fallback sentences don't collide with each other", () => {
  // recordThrottleOnce matches on this exact string within the current window
  // to decide whether it has already written a row. If the null-ip and
  // null-email fallbacks ever produced the same text for the same bucket
  // *kind*, two genuinely different refusals (no attributable address vs. no
  // email in play) could suppress one another.
  assert.notEqual(throttleDetail("login:ip", null), throttleDetail("login:email", null));
});

// --- determinism, which is what makes the dedup query correct ----------

test("the same bucket and subject always produce the same sentence", () => {
  // recordThrottleOnce's whole dedup strategy rests on this: two refusals in
  // the same window for the same (bucket, subject) must be byte-identical, or
  // the "already written?" query would never find its own earlier row and
  // every refusal would write again.
  const a = throttleDetail("invitation:accept:email", "person@example.com");
  const b = throttleDetail("invitation:accept:email", "person@example.com");
  assert.equal(a, b);
});

test("different subjects in the same bucket produce different sentences", () => {
  // The other side of the same property: two different attackers throttled on
  // the same bucket must not be folded into one row by an over-eager dedup.
  const a = throttleDetail("invitation:accept:ip", "203.0.113.9");
  const b = throttleDetail("invitation:accept:ip", "203.0.113.10");
  assert.notEqual(a, b);
});
