// Tests for the retention cutoffs (§9, Phase 6). Run with `npm test`.
//
// The arithmetic only, which is the part worth protecting: a cutoff written
// the wrong way round deletes live credentials instead of dead ones, and the
// symptom of that is every member being signed out at once rather than an
// error anybody could read. The deletes themselves are three one-line Prisma
// calls against indexed timestamp columns and are exercised, along with
// everything else that touches the database, by the integration suite.

import test from "node:test";
import assert from "node:assert/strict";

import { SPENT_TOKEN_GRACE_MS, retentionCutoffs, sweptAnything } from "./retentionPolicy.ts";

const NOW = new Date("2026-08-31T12:00:00.000Z");

test("expired rows are cut off at the present moment, not before it", () => {
  // `expiredBefore` must be exactly now: a row expiring one second ago is
  // dead and collectable, and a row expiring one second from now is still a
  // working credential. Nudging this cutoff into the future signs people out.
  assert.equal(retentionCutoffs(NOW).expiredBefore.toISOString(), NOW.toISOString());
});

test("spent links are kept for the grace period, then collected", () => {
  const { spentBefore } = retentionCutoffs(NOW);
  assert.equal(spentBefore.toISOString(), "2026-08-01T12:00:00.000Z");
  assert.equal(NOW.getTime() - spentBefore.getTime(), SPENT_TOKEN_GRACE_MS);
});

test("the spent cutoff is in the past, never the future", () => {
  // Subtracting in the wrong direction would put the cutoff a month ahead and
  // delete every reset link the moment it was used, including ones still
  // inside the window somebody would ask about.
  assert.ok(retentionCutoffs(NOW).spentBefore < NOW);
});

test("the grace period is long enough to answer a question about last week", () => {
  assert.ok(SPENT_TOKEN_GRACE_MS >= 7 * 24 * 60 * 60 * 1000);
});

test("a sweep that found nothing stays quiet", () => {
  // A quiet box sweeps nothing most days, and a daily log line saying so
  // would bury the ticks that did something.
  assert.equal(sweptAnything({ sessions: 0, authTokens: 0, rateLimitCounters: 0 }), false);
});

test("a sweep that found anything at all is worth a line", () => {
  assert.equal(sweptAnything({ sessions: 0, authTokens: 0, rateLimitCounters: 1 }), true);
  assert.equal(sweptAnything({ sessions: 2, authTokens: 0, rateLimitCounters: 0 }), true);
});
