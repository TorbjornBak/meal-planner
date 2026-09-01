// Tests for the dashboard's random dinners (§2e). Run with `npm test`.
//
// Randomness is the awkward thing to test and the reason the rng is a
// parameter. Two techniques below: a scripted rng, for asserting exactly which
// recipe comes back from a known draw, and a seeded one run many times, for
// the properties that have to hold on *every* draw — no repeats, nothing
// ineligible, never short when the shelf is full. A flaky test here would be
// indistinguishable from the bug it is meant to catch, so neither uses
// Math.random.

import test from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_SUGGESTION_COUNT,
  eligibleForSuggestion,
  pickRandom,
  suggestRecipes,
} from "./recipeSuggestions.ts";

/** A rng that hands back the numbers you give it, then zeroes for ever. */
function scripted(values) {
  let i = 0;
  return () => (i < values.length ? values[i++] : 0);
}

/** A small deterministic generator, for running a property many times. */
function seeded(seed) {
  let s = seed >>> 0;
  return () => {
    // xorshift32 — not cryptography, just a repeatable spread of numbers.
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    return s / 4294967296;
  };
}

const dinner = (id, category = null) => ({ id, kind: "DINNER", category });
const drink = (id, category = null) => ({ id, kind: "DRINK", category });
const side = (id, category = null) => ({ id, kind: "SIDE", category });
const dessert = (id, category = null) => ({ id, kind: "DESSERT", category });

const LIBRARY = [
  dinner("ragu", "MEAT"),
  dinner("torsk", "FISH"),
  dinner("dal", "VEGAN"),
  dinner("omelet", "VEGETARIAN"),
  dinner("rest", null),
  drink("cortado", null),
  // Both here on purpose, and for different reasons. A dessert can't go on a
  // night at all; a side can, and is still not an answer to "what shall we
  // have?" — it is the one exclusion that doesn't fall out of the plan (§2c).
  dessert("pavlova", "VEGETARIAN"),
  side("gronsalat", "VEGAN"),
];

// -----------------------------------------------------------------------------
// What may be offered
// -----------------------------------------------------------------------------

test("only dinners are suggested — not drinks, desserts or sides", () => {
  // The card asks what the meal is. A flat white and a pavlova can't go on a
  // night at all (§3), and the salad — which can — still isn't an answer to
  // the question: you reach for a side once you know what it goes next to.
  const ids = eligibleForSuggestion(LIBRARY).map((r) => r.id);
  assert.ok(!ids.includes("cortado"));
  assert.ok(!ids.includes("pavlova"));
  assert.ok(!ids.includes("gronsalat"));
  assert.equal(ids.length, 5);
});

test("a dinner already on the week is not offered back", () => {
  const ids = eligibleForSuggestion(LIBRARY, { planned: ["ragu", "dal"] }).map(
    (r) => r.id,
  );
  assert.deepEqual(ids, ["torsk", "omelet", "rest"]);
});

test("the category filter reaches the suggestions", () => {
  assert.deepEqual(
    eligibleForSuggestion(LIBRARY, { filter: "FISH" }).map((r) => r.id),
    ["torsk"],
  );
  // And it brings the vegan-counts-as-vegetarian rule with it (§2d), rather
  // than re-deciding it here.
  // Not the vegan salad or the vegetarian pavlova: the kind is asked first, so
  // a category filter can never widen what may be offered.
  assert.deepEqual(
    eligibleForSuggestion(LIBRARY, { filter: "VEGETARIAN" }).map((r) => r.id),
    ["dal", "omelet"],
  );
});

test("an uncategorised dinner is offered under Any and never under a category", () => {
  assert.ok(eligibleForSuggestion(LIBRARY).some((r) => r.id === "rest"));
  for (const filter of ["MEAT", "FISH", "VEGETARIAN", "VEGAN"]) {
    assert.ok(
      !eligibleForSuggestion(LIBRARY, { filter }).some((r) => r.id === "rest"),
      `an uncategorised recipe was offered as ${filter}`,
    );
  }
});

test("eligibility keeps the caller's order, so nothing becomes a ranking", () => {
  assert.deepEqual(
    eligibleForSuggestion(LIBRARY).map((r) => r.id),
    ["ragu", "torsk", "dal", "omelet", "rest"],
  );
});

// -----------------------------------------------------------------------------
// The draw itself
// -----------------------------------------------------------------------------

test("picking takes exactly what was asked for, without repeats", () => {
  const rng = seeded(20260830);
  for (let run = 0; run < 500; run++) {
    const picks = pickRandom(["a", "b", "c", "d", "e"], 3, rng);
    assert.equal(picks.length, 3);
    assert.equal(new Set(picks).size, 3, "the same item came back twice");
  }
});

test("a short library gives everything it has rather than failing", () => {
  const picks = pickRandom(["a", "b"], 3, seeded(7));
  assert.equal(picks.length, 2);
  assert.equal(new Set(picks).size, 2);
  assert.deepEqual(pickRandom([], 3, seeded(7)), []);
});

test("picking is uniform enough that no item is unreachable", () => {
  // The property that dies quietly if the swap loop is written wrong: a
  // partial shuffle that never looks past position `count` can only ever
  // return the first few items, and every test above would still pass.
  const items = ["a", "b", "c", "d", "e", "f", "g", "h"];
  const rng = seeded(99);
  const seen = new Set();
  for (let run = 0; run < 2000; run++) {
    for (const pick of pickRandom(items, 2, rng)) seen.add(pick);
  }
  assert.equal(seen.size, items.length, "some items can never be suggested");
});

test("picking doesn't disturb the list it was given", () => {
  const items = ["a", "b", "c", "d"];
  pickRandom(items, 3, seeded(3));
  assert.deepEqual(items, ["a", "b", "c", "d"]);
});

test("a random() of exactly 1 doesn't index off the end", () => {
  // Math.random never returns 1, but this one is injected — and the failure
  // would be an `undefined` recipe rendered into the card.
  const picks = pickRandom(["a", "b", "c"], 3, scripted([1, 1, 1]));
  assert.deepEqual([...picks].sort(), ["a", "b", "c"]);
});

// -----------------------------------------------------------------------------
// Shuffling
// -----------------------------------------------------------------------------

test("the shuffle avoids what is already on screen", () => {
  const library = [
    dinner("a"), dinner("b"), dinner("c"),
    dinner("d"), dinner("e"), dinner("f"),
  ];
  const rng = seeded(1234);
  for (let run = 0; run < 200; run++) {
    const picks = suggestRecipes(library, {
      count: 3,
      avoid: ["a", "b", "c"],
      random: rng,
    });
    assert.deepEqual([...picks.map((r) => r.id)].sort(), ["d", "e", "f"]);
  }
});

test("a library too small to avoid repeats fills the card anyway", () => {
  // Four dinners, three slots: one is necessarily a repeat. The unseen one
  // must be there, and the card must not come back short — an empty card
  // insisting there is nothing new is worse than showing yesterday's ragù.
  const library = [dinner("a"), dinner("b"), dinner("c"), dinner("d")];
  const rng = seeded(555);
  for (let run = 0; run < 200; run++) {
    const ids = suggestRecipes(library, {
      count: 3,
      avoid: ["a", "b", "c"],
      random: rng,
    }).map((r) => r.id);
    assert.equal(ids.length, 3);
    assert.equal(new Set(ids).size, 3, "the card showed the same recipe twice");
    assert.ok(ids.includes("d"), "the one unseen dinner wasn't offered");
  }
});

test("suggestions obey the filter and the plan together", () => {
  const rng = seeded(42);
  for (let run = 0; run < 200; run++) {
    const ids = suggestRecipes(LIBRARY, {
      filter: "VEGETARIAN",
      planned: ["dal"],
      random: rng,
    }).map((r) => r.id);
    assert.deepEqual(ids, ["omelet"]);
  }
});

test("an empty shelf suggests nothing rather than throwing", () => {
  assert.deepEqual(suggestRecipes([], { random: seeded(1) }), []);
  assert.deepEqual(
    suggestRecipes(LIBRARY, { filter: "FISH", planned: ["torsk"], random: seeded(1) }),
    [],
  );
});

test("three is what the card asks for when nobody says", () => {
  assert.equal(DEFAULT_SUGGESTION_COUNT, 3);
  assert.equal(suggestRecipes(LIBRARY, { random: seeded(8) }).length, 3);
});
