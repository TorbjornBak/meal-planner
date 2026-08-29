// Tests for reshuffling dinners between nights (§3). Run with `npm test`.
//
// The plan page and POST /api/plan/move both run `moveDinner`, so what it does
// here is what the calendar shows and what the database ends up holding.

import test from "node:test";
import assert from "node:assert/strict";

import { moveDinner, dinnerPlace } from "./planMove.ts";

/** A week as `id@day:position` strings, in the order the calendar reads it. */
const shape = (slots) =>
  slots.map((s) => `${s.id}@${s.dayOfWeek}:${s.position}`);

/** Monday holds a and b; Wednesday holds c. */
const week = () => [
  { id: "a", dayOfWeek: 0, position: 0 },
  { id: "b", dayOfWeek: 0, position: 1 },
  { id: "c", dayOfWeek: 2, position: 0 },
];

test("a dinner moved to an empty night lands alone on it", () => {
  assert.deepEqual(shape(moveDinner(week(), "b", 4, 0)), [
    "a@0:0",
    "c@2:0",
    "b@4:0",
  ]);
});

test("the night it left closes the gap behind it", () => {
  // b was Monday's second dinner; with it gone, nothing may still be numbered 1.
  const after = moveDinner(week(), "a", 4, 0);
  assert.deepEqual(shape(after.filter((s) => s.dayOfWeek === 0)), ["b@0:0"]);
});

test("dropping onto an occupied night pushes the rest down", () => {
  assert.deepEqual(shape(moveDinner(week(), "a", 2, 0)), ["b@0:0", "a@2:0", "c@2:1"]);
});

test("an index past the end means last", () => {
  assert.deepEqual(shape(moveDinner(week(), "a", 2, 99)), ["b@0:0", "c@2:0", "a@2:1"]);
});

test("a negative index means first", () => {
  assert.deepEqual(shape(moveDinner(week(), "c", 0, -3)), [
    "c@0:0",
    "a@0:1",
    "b@0:2",
  ]);
});

test("reordering within one night swaps the two dinners", () => {
  assert.deepEqual(shape(moveDinner(week(), "a", 0, 1)), ["b@0:0", "a@0:1", "c@2:0"]);
});

test("dropping a dinner back where it was changes nothing", () => {
  const before = week();
  assert.deepEqual(shape(moveDinner(before, "a", 0, 0)), shape(before));
  assert.deepEqual(shape(moveDinner(before, "c", 2, 0)), shape(before));
});

test("nights the move didn't touch keep their positions, gaps and all", () => {
  // Positions only have to sort; a week written by an older path may well have
  // holes in it, and a move onto Monday is no reason to rewrite Sunday's rows.
  const gappy = [
    { id: "a", dayOfWeek: 0, position: 0 },
    { id: "x", dayOfWeek: 6, position: 3 },
    { id: "y", dayOfWeek: 6, position: 9 },
  ];
  const after = moveDinner(gappy, "a", 1, 0);
  assert.deepEqual(shape(after.filter((s) => s.dayOfWeek === 6)), ["x@6:3", "y@6:9"]);
});

test("the week comes back in calendar order however it went in", () => {
  const jumbled = [
    { id: "c", dayOfWeek: 2, position: 0 },
    { id: "b", dayOfWeek: 0, position: 1 },
    { id: "a", dayOfWeek: 0, position: 0 },
  ];
  assert.deepEqual(shape(moveDinner(jumbled, "c", 2, 0)), ["a@0:0", "b@0:1", "c@2:0"]);
});

test("the other columns of a slot travel with it", () => {
  // The page moves whole slot objects — recipe, photo, servings override — and
  // gets them back to render; only the two positional fields may differ.
  const rich = [{ id: "a", dayOfWeek: 0, position: 0, servingsOverride: 6 }];
  assert.deepEqual(moveDinner(rich, "a", 3, 0), [
    { id: "a", dayOfWeek: 3, position: 0, servingsOverride: 6 },
  ]);
});

test("a dinner that is no longer there leaves the week alone", () => {
  assert.deepEqual(shape(moveDinner(week(), "gone", 5, 0)), shape(week()));
});

test("the input is not modified", () => {
  const before = week();
  moveDinner(before, "a", 4, 0);
  assert.deepEqual(shape(before), ["a@0:0", "b@0:1", "c@2:0"]);
});

test("dinnerPlace says where a dinner sits now", () => {
  assert.deepEqual(dinnerPlace(week(), "a"), { day: 0, index: 0 });
  assert.deepEqual(dinnerPlace(week(), "b"), { day: 0, index: 1 });
  assert.deepEqual(dinnerPlace(week(), "c"), { day: 2, index: 0 });
  assert.equal(dinnerPlace(week(), "gone"), null);
});

test("dinnerPlace counts by order, not by the stored number", () => {
  const gappy = [
    { id: "x", dayOfWeek: 6, position: 3 },
    { id: "y", dayOfWeek: 6, position: 9 },
  ];
  assert.deepEqual(dinnerPlace(gappy, "y"), { day: 6, index: 1 });
});

test("a drop is a no-op exactly when it matches dinnerPlace", () => {
  // This pairing is what lets the page skip the request for a drag that ends
  // where it began — the commonest gesture there is.
  const before = week();
  for (const id of ["a", "b", "c"]) {
    const at = dinnerPlace(before, id);
    assert.deepEqual(shape(moveDinner(before, id, at.day, at.index)), shape(before));
  }
});
