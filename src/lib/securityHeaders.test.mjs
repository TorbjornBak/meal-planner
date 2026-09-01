// Tests for the security response headers and the CSP in particular (§9, §10,
// Phase 6). Run with `npm test`.
//
// The plan requires the CSP specifically to be tested, which is the whole
// reason it's a pure function in its own module rather than a string built
// inline in src/middleware.ts: none of this needs a browser, a server, or a
// database to check.

import test from "node:test";
import assert from "node:assert/strict";

import { buildCsp, httpsIsGuaranteed, securityHeaders } from "./securityHeaders.ts";

function csp(overrides = {}) {
  return buildCsp({ nonce: "test-nonce-value", allowEval: false, ...overrides });
}

// --- the required directives, verbatim --------------------------------------

test("frame-ancestors is 'none'", () => {
  assert.match(csp(), /frame-ancestors 'none'/);
});

test("object-src is 'none'", () => {
  assert.match(csp(), /object-src 'none'/);
});

test("default-src is 'self'", () => {
  assert.match(csp(), /(^|; )default-src 'self'(;|$)/);
});

test("no directive ever contains 'unsafe-eval' in production", () => {
  assert.doesNotMatch(csp({ allowEval: false }), /unsafe-eval/);
});

test("'unsafe-eval' appears only in script-src, and only when explicitly allowed", () => {
  const withEval = csp({ allowEval: true });
  assert.match(withEval, /script-src[^;]*'unsafe-eval'/);
  // Nowhere else in the policy — a dev-only relaxation that leaked into, say,
  // default-src would quietly widen every other directive that falls back to it.
  const withoutScriptSrc = withEval.replace(/script-src[^;]*/, "");
  assert.doesNotMatch(withoutScriptSrc, /unsafe-eval/);
});

test("script-src carries the nonce and strict-dynamic, not unsafe-inline", () => {
  const value = csp({ nonce: "abc123" });
  assert.match(value, /script-src[^;]*'nonce-abc123'/);
  assert.match(value, /script-src[^;]*'strict-dynamic'/);
  const scriptSrc = value.match(/script-src[^;]*/)[0];
  assert.doesNotMatch(scriptSrc, /'unsafe-inline'/);
});

test("the nonce is per-request: two builds never share one", () => {
  const a = buildCsp({ nonce: "one-time-value-a", allowEval: false });
  const b = buildCsp({ nonce: "one-time-value-b", allowEval: false });
  assert.notEqual(a, b);
  assert.match(a, /'nonce-one-time-value-a'/);
  assert.match(b, /'nonce-one-time-value-b'/);
});

test("style-src's unsafe-inline is scoped to style-src, not smuggled into script-src", () => {
  const value = csp();
  assert.match(value, /style-src[^;]*'unsafe-inline'/);
  const scriptSrc = value.match(/script-src[^;]*/)[0];
  assert.doesNotMatch(scriptSrc, /'unsafe-inline'/);
});

test("img-src, font-src and connect-src are locked to 'self'", () => {
  const value = csp();
  for (const directive of ["img-src", "font-src", "connect-src", "worker-src"]) {
    assert.match(value, new RegExp(`${directive} 'self'(;|$)`));
  }
});

test("base-uri and form-action don't fall back to default-src's leniency", () => {
  const value = csp();
  assert.match(value, /base-uri 'self'/);
  assert.match(value, /form-action 'self'/);
});

// --- HSTS gate ---------------------------------------------------------------

test("HSTS is guaranteed-safe only under production plus an https APP_URL", () => {
  assert.equal(
    httpsIsGuaranteed({ nodeEnv: "production", appUrl: "https://box.example.ts.net" }),
    true,
  );
});

test("HSTS is withheld outside production even with an https APP_URL", () => {
  assert.equal(
    httpsIsGuaranteed({ nodeEnv: "development", appUrl: "https://box.example.ts.net" }),
    false,
  );
  assert.equal(
    httpsIsGuaranteed({ nodeEnv: undefined, appUrl: "https://box.example.ts.net" }),
    false,
  );
});

test("HSTS is withheld in production when APP_URL is missing, invalid, or plain http", () => {
  assert.equal(httpsIsGuaranteed({ nodeEnv: "production", appUrl: undefined }), false);
  assert.equal(httpsIsGuaranteed({ nodeEnv: "production", appUrl: "not a url" }), false);
  assert.equal(
    httpsIsGuaranteed({ nodeEnv: "production", appUrl: "http://127.0.0.1:3000" }),
    false,
  );
});

test("securityHeaders omits Strict-Transport-Security when HTTPS is not guaranteed", () => {
  const headers = securityHeaders({ nonce: "n", allowEval: false, httpsGuaranteed: false });
  assert.equal(headers.some(([name]) => name === "Strict-Transport-Security"), false);
});

test("securityHeaders includes Strict-Transport-Security when HTTPS is guaranteed", () => {
  const headers = securityHeaders({ nonce: "n", allowEval: false, httpsGuaranteed: true });
  const hsts = headers.find(([name]) => name === "Strict-Transport-Security");
  assert.ok(hsts, "expected an HSTS header");
  assert.match(hsts[1], /max-age=\d+/);
  // A high max-age is exactly the property that makes this header dangerous
  // to send speculatively — assert it's actually meaningful, not a token gesture.
  const maxAge = Number(hsts[1].match(/max-age=(\d+)/)[1]);
  assert.ok(maxAge >= 15552000, "HSTS max-age should be at least ~6 months");
});

// --- the rest of the fixed set ------------------------------------------------

test("securityHeaders always sets the non-conditional headers", () => {
  const headers = Object.fromEntries(
    securityHeaders({ nonce: "n", allowEval: false, httpsGuaranteed: false }),
  );
  assert.equal(headers["X-Frame-Options"], "DENY");
  assert.equal(headers["X-Content-Type-Options"], "nosniff");
  assert.equal(headers["Cross-Origin-Opener-Policy"], "same-origin");
  assert.ok(headers["Permissions-Policy"]);
  assert.ok(headers["Content-Security-Policy"]);
});

test("Referrer-Policy is the strictest option, since reset and invite tokens live in the path", () => {
  const headers = Object.fromEntries(
    securityHeaders({ nonce: "n", allowEval: false, httpsGuaranteed: false }),
  );
  assert.equal(headers["Referrer-Policy"], "no-referrer");
});

test("Permissions-Policy denies the powerful features this app never uses", () => {
  const headers = Object.fromEntries(
    securityHeaders({ nonce: "n", allowEval: false, httpsGuaranteed: false }),
  );
  for (const feature of ["camera", "microphone", "geolocation", "payment", "usb"]) {
    assert.match(headers["Permissions-Policy"], new RegExp(`${feature}=\\(\\)`));
  }
});
