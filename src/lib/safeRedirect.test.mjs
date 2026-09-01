// Tests for the `?next=` guard (§9, Phase 6). Run with `npm test`.
//
// The cases that matter are the ones a startsWith("/") && !startsWith("//")
// check waves through. Each of those resolves to another origin in a real
// browser, so they are asserted against the same URL parser the browser uses
// rather than against a regex that agrees with our intuition.

import test from "node:test";
import assert from "node:assert/strict";

import { safeNextPath } from "./safeRedirect.ts";

const ORIGIN = "https://app.example.com";

test("an ordinary relative path is followed", () => {
  assert.equal(safeNextPath("/plan", ORIGIN), "/plan");
  assert.equal(safeNextPath("/invite/abc123", ORIGIN), "/invite/abc123");
});

test("query and fragment survive the round trip", () => {
  assert.equal(safeNextPath("/recipes?sort=name#top", ORIGIN), "/recipes?sort=name#top");
});

test("a protocol-relative path is refused", () => {
  assert.equal(safeNextPath("//evil.com", ORIGIN), "/");
  assert.equal(safeNextPath("//evil.com/plan", ORIGIN), "/");
});

test("a backslash path is refused — this is what the old guard let through", () => {
  // new URL("/\\evil.com", origin) is https://evil.com/ in any WHATWG parser.
  assert.equal(safeNextPath("/\\evil.com", ORIGIN), "/");
  assert.equal(safeNextPath("/\\/evil.com", ORIGIN), "/");
  assert.equal(safeNextPath("\\\\evil.com", ORIGIN), "/");
});

test("an absolute URL to another origin is refused, path and all", () => {
  assert.equal(safeNextPath("https://evil.com/plan", ORIGIN), "/");
  assert.equal(safeNextPath("http://app.example.com/plan", ORIGIN), "/");
});

test("an absolute URL to our own origin is reduced to its path", () => {
  assert.equal(safeNextPath("https://app.example.com/plan", ORIGIN), "/plan");
});

test("a non-http scheme is refused", () => {
  assert.equal(safeNextPath("javascript:alert(1)", ORIGIN), "/");
  assert.equal(safeNextPath("data:text/html,<script>", ORIGIN), "/");
});

test("absent, empty and unparseable candidates fall back", () => {
  assert.equal(safeNextPath(null, ORIGIN), "/");
  assert.equal(safeNextPath(undefined, ORIGIN), "/");
  assert.equal(safeNextPath("", ORIGIN), "/");
});

test("the fallback is configurable", () => {
  assert.equal(safeNextPath("//evil.com", ORIGIN, "/login"), "/login");
});
