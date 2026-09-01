// Tests for the throttle-audit fingerprint (Security review, LOW-2). Run with
// `npm test`.
//
// src/lib/rateLimit.ts writes an AUTH_THROTTLED audit row whenever a limit
// trips, and used to put the probed subject straight into it — the plaintext
// email or IP an *unauthenticated* caller typed at a login, forgot-password,
// or invitation form, in a column and a sentence that outlive the rate-limit
// counter itself. `throttleFingerprint` is what recordThrottleOnce now writes
// instead: a short, stable, one-way stand-in built from the same
// AUTH_SECRET-keyed HMAC as the counter table above it, so an admin skimming
// the audit log can still tell "the same subject tripped this three times"
// from "three different subjects did," without the row ever holding the
// address itself.
//
// This only exercises the fingerprint function, not recordThrottleOnce as a
// whole — that also writes to Postgres, and this suite is not allowed to
// assume a database is reachable. The database-backed half belongs next to
// src/lib/rateLimit.integration.test.mjs, not here.
//
// rateLimit.ts reaches Prisma and Next through the `@/` path alias and the
// bare `next/server` specifier, which only Next.js and `tsc` resolve; this
// file needs neither at runtime (throttleFingerprint touches only
// crypto.subtle) but still has to satisfy the module loader to import it at
// all, hence the same resolution hook as the integration test.

import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import path from "node:path";

// The fingerprint is an HMAC over AUTH_SECRET, same as the counter table
// itself — set a throwaway one so this file doesn't need a real deployment
// secret to run.
process.env.AUTH_SECRET ??= "ratelimit-fingerprint-test-secret-do-not-use-elsewhere";

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

const { throttleFingerprint } = await import("@/lib/rateLimit");

test("a null subject fingerprints to null", async () => {
  assert.equal(await throttleFingerprint("login:email", null), null);
});

test("the same bucket and subject fingerprint the same way twice", async () => {
  const a = await throttleFingerprint("login:email", "person@example.com");
  const b = await throttleFingerprint("login:email", "person@example.com");
  assert.equal(a, b);
});

test("different subjects in the same bucket fingerprint differently", async () => {
  const a = await throttleFingerprint("login:email", "person@example.com");
  const b = await throttleFingerprint("login:email", "someone-else@example.com");
  assert.notEqual(a, b);
});

test("the same subject in different buckets fingerprints differently", async () => {
  // Domain separation matters here for the same reason it matters for the
  // counter table: an email throttled on login and on password-forgot in the
  // same window shouldn't produce two audit rows that look correlatable by
  // fingerprint alone.
  const a = await throttleFingerprint("login:email", "person@example.com");
  const b = await throttleFingerprint("password-forgot:email", "person@example.com");
  assert.notEqual(a, b);
});

test("the fingerprint never contains the plaintext subject", async () => {
  const subject = "person@example.com";
  const fingerprint = await throttleFingerprint("login:email", subject);
  assert.ok(fingerprint);
  assert.ok(!fingerprint.includes(subject));
  // Hex digits only, and short enough to be a fingerprint rather than a
  // roundtrippable encoding of the input.
  assert.match(fingerprint, /^[0-9a-f]{12}$/);
});
