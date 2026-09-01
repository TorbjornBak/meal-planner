// Tests for which pages answer without a session (§9, §10). Run with `npm test`.
//
// Two callers read this predicate and must agree: src/middleware.ts decides
// whether to serve a page or bounce to /login, and src/components/TopNav.tsx
// decides whether to draw a nav bar of links into the app. A page that drifted
// into one answer but not the other is either a nav bar shown to a stranger or
// — much worse — a private page that stopped being gated. Both halves are the
// same pure function of a pathname, so both are checked here.

import test from "node:test";
import assert from "node:assert/strict";

import { isPublicPage } from "./publicPages.ts";

// --- what's open, and why --------------------------------------------------

test("the landing page is public", () => {
  // The whole point of Phase "front door": a stranger types the bare domain
  // and gets a page rather than a login form for an app they can't identify.
  assert.equal(isPublicPage("/"), true);
});

test("the ways in are public", () => {
  for (const path of ["/login", "/forgot", "/setup", "/reset/abc123", "/invite/abc123"]) {
    assert.equal(isPublicPage(path), true, `${path} should be public`);
  }
});

test("the unsubscribe landing is public, because it's opened from a mail client", () => {
  assert.equal(isPublicPage("/newsletter/unsubscribed"), true);
});

// --- what isn't ------------------------------------------------------------

test("the dashboard is not public — it moved off / precisely so it could stay shut", () => {
  assert.equal(isPublicPage("/dashboard"), false);
});

test("no household page is public", () => {
  for (const path of [
    "/plan",
    "/recipes",
    "/recipes/abc123",
    "/recipes/new",
    "/shopping",
    "/pantry",
    "/spending",
    "/settings",
    "/admin",
  ]) {
    assert.equal(isPublicPage(path), false, `${path} must not be public`);
  }
});

test("the API is not this function's business", () => {
  // Middleware keeps the endpoints in its own list. If /api/login ever became
  // "public" *here*, TopNav would be asking a question about a nav bar that no
  // /api path has, and the two lists would have started to blur.
  for (const path of ["/api/login", "/api/setup", "/api/plan", "/api/recipes"]) {
    assert.equal(isPublicPage(path), false, `${path} must not be public here`);
  }
});

// --- prefixes are prefixes of a segment, not of a string -------------------

test("a path that merely starts with a public page's name is not public", () => {
  // The exact-match entries have to stay exact: a future /loginish or
  // /setup-wizard page would otherwise inherit an exemption nobody granted it.
  for (const path of ["/logins", "/login/extra", "/setups", "/forgotten"]) {
    assert.equal(isPublicPage(path), false, `${path} must not be public`);
  }
});

test("the token routes are public only with a token path under them", () => {
  // "/reset" and "/invite" bare are not pages this app serves; only the
  // token-carrying children are, and the credential is the token itself.
  assert.equal(isPublicPage("/reset"), false);
  assert.equal(isPublicPage("/invite"), false);
  assert.equal(isPublicPage("/reset/"), true);
  assert.equal(isPublicPage("/invite/"), true);
});
