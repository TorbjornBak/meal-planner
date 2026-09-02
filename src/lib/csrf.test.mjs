// Tests for the origin/CSRF check (§9, Phase 6). Run with `npm test`.
//
// Everything in src/lib/csrf.ts is a total function of plain strings, which is
// the point: the interesting inputs here are exactly the ones a real browser
// never produces (missing headers, a forged Origin, a bearer header on a
// request with no cookie jar at all), and none of them need a running server
// or a real Request object to exercise.

import test from "node:test";
import assert from "node:assert/strict";

import { csrfVerdict, expectedOrigin } from "./csrf.ts";

const SELF = "https://mealplanner.example.com";

function base(overrides = {}) {
  return {
    method: "POST",
    pathname: "/api/trips",
    originHeader: SELF,
    refererHeader: null,
    authorizationHeader: null,
    expectedOrigin: SELF,
    ...overrides,
  };
}

// --- method scope ----------------------------------------------------------

test("read-only methods are never checked", () => {
  for (const method of ["GET", "HEAD", "OPTIONS"]) {
    assert.equal(
      csrfVerdict(base({ method, originHeader: "https://evil.example", expectedOrigin: SELF })),
      "allow",
    );
  }
});

test("every mutating method is checked", () => {
  for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
    assert.equal(
      csrfVerdict(base({ method, originHeader: "https://evil.example" })),
      "block",
    );
  }
});

// --- the ordinary browser case ----------------------------------------------

test("a same-origin Origin header is allowed", () => {
  assert.equal(csrfVerdict(base({ originHeader: SELF })), "allow");
});

test("a cross-origin Origin header is blocked", () => {
  assert.equal(csrfVerdict(base({ originHeader: "https://evil.example" })), "block");
});

test("Referer is consulted only when Origin is absent", () => {
  assert.equal(
    csrfVerdict(base({ originHeader: null, refererHeader: `${SELF}/plan?x=1` })),
    "allow",
  );
  assert.equal(
    csrfVerdict(
      base({ originHeader: SELF, refererHeader: "https://evil.example/" }),
    ),
    "allow",
    "Origin present and matching should win even if Referer looks wrong",
  );
});

test("a cross-origin Referer is blocked when Origin is absent", () => {
  assert.equal(
    csrfVerdict(base({ originHeader: null, refererHeader: "https://evil.example/" })),
    "block",
  );
});

test("an unparsable Referer is treated as no evidence at all", () => {
  assert.equal(
    csrfVerdict(base({ originHeader: null, refererHeader: "not a url" })),
    "block",
  );
});

test("both Origin and Referer absent is blocked, not waved through", () => {
  // A modern browser always sends Origin on a mutating request; a caller with
  // neither header is a script, a very old browser, or a request with the
  // evidence deliberately stripped — none of which this check exists to trust.
  assert.equal(
    csrfVerdict(base({ originHeader: null, refererHeader: null })),
    "block",
  );
});

test("no expected origin at all fails closed", () => {
  // This is the "APP_URL is missing in production" case (see expectedOrigin
  // below) — even a same-origin-looking request has nothing to be compared
  // against, so it is refused rather than admitted by default.
  assert.equal(csrfVerdict(base({ expectedOrigin: null })), "block");
});

// --- exemptions --------------------------------------------------------------

test("a well-formed bearer header exempts the request regardless of origin", () => {
  assert.equal(
    csrfVerdict(
      base({
        originHeader: null,
        refererHeader: null,
        authorizationHeader: "Bearer some-cron-secret",
      }),
    ),
    "allow",
  );
});

test("a malformed Authorization header does not exempt the request", () => {
  for (const value of ["Bearer", "Bearer ", "Basic dXNlcjpwYXNz", ""]) {
    assert.equal(
      csrfVerdict(
        base({ originHeader: "https://evil.example", authorizationHeader: value }),
      ),
      "block",
      `"${value}" should not exempt the request`,
    );
  }
});

test("/api/capture is exempt by path, cross-origin, even with no bearer header", () => {
  assert.equal(
    csrfVerdict(
      base({
        pathname: "/api/capture",
        originHeader: "https://some-recipe-site.example",
      }),
    ),
    "allow",
  );
});

test("the /api/capture exemption is exact, not a prefix", () => {
  assert.equal(
    csrfVerdict(
      base({
        pathname: "/api/capture/extra",
        originHeader: "https://evil.example",
      }),
    ),
    "block",
  );
});

// --- expectedOrigin ----------------------------------------------------------

test("expectedOrigin prefers a configured APP_URL over the request's own origin", () => {
  assert.equal(
    expectedOrigin({
      appUrl: "https://mealplanner.example.com/",
      nodeEnv: "production",
      requestOrigin: "http://127.0.0.1:3000",
    }),
    "https://mealplanner.example.com",
  );
});

test("expectedOrigin returns null in production when APP_URL is missing or invalid", () => {
  assert.equal(
    expectedOrigin({ appUrl: undefined, nodeEnv: "production", requestOrigin: "http://x" }),
    null,
  );
  assert.equal(
    expectedOrigin({ appUrl: "not a url", nodeEnv: "production", requestOrigin: "http://x" }),
    null,
  );
});

test("expectedOrigin falls back to the request's own origin outside production", () => {
  assert.equal(
    expectedOrigin({ appUrl: undefined, nodeEnv: "development", requestOrigin: "http://localhost:3000" }),
    "http://localhost:3000",
  );
  assert.equal(
    expectedOrigin({ appUrl: undefined, nodeEnv: undefined, requestOrigin: "http://localhost:3000" }),
    "http://localhost:3000",
  );
});

test("expectedOrigin still prefers a configured APP_URL in development", () => {
  // A developer who has genuinely set APP_URL gets it honoured, rather than
  // the dev fallback silently overriding their configuration.
  assert.equal(
    expectedOrigin({
      appUrl: "https://mealplanner.example.com",
      nodeEnv: "development",
      requestOrigin: "http://localhost:3000",
    }),
    "https://mealplanner.example.com",
  );
});
