// Tests for the library's sections (§2c). Run with `npm test`.
//
// Most of this module is a lookup table, and a lookup table's failure mode is
// not a wrong answer but a missing one: somebody adds a kind to RECIPE_KINDS,
// wires up the tab, and finds out three screens later that it has no word for
// its serving count. So the test that earns its keep is the one that walks
// every kind and insists it is fully furnished.

import test from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_RECIPE_KIND,
  RECIPE_KINDS,
  emptyKindLine,
  isPlannable,
  isSuggestable,
  kindLabel,
  kindPlural,
  yieldNoun,
} from "./recipeKind.ts";

test("every kind has every word the UI asks it for", () => {
  for (const kind of RECIPE_KINDS) {
    for (const [what, word] of [
      ["label", kindLabel(kind)],
      ["plural", kindPlural(kind)],
      ["yield noun", yieldNoun(kind)],
      ["empty line", emptyKindLine(kind)],
    ]) {
      assert.equal(typeof word, "string", `${kind} has no ${what}`);
      assert.ok(word.length > 0, `${kind}'s ${what} is empty`);
    }
  }
});

test("dinner leads the list and is what anything unstated becomes", () => {
  // The library opens on dinners, and every recipe that predates §2c is one.
  assert.equal(RECIPE_KINDS[0], "DINNER");
  assert.equal(DEFAULT_RECIPE_KIND, "DINNER");
});

test("a night holds dinners and the sides that go with them", () => {
  // A meal is the roast and the salad, cooked the same evening and bought for
  // together — so a side reaches the plan, and through it the shopping list
  // (§5). A picker that offers a flat white for Tuesday is worse than no
  // picker; one that can't offer the salad makes you shop for it by hand.
  assert.equal(isPlannable("DINNER"), true);
  assert.equal(isPlannable("SIDE"), true);
  assert.equal(isPlannable("DRINK"), false);
  assert.equal(isPlannable("DESSERT"), false);
});

test("only a dinner answers \"what shall we have?\"", () => {
  // Narrower than isPlannable, and the whole reason the two are separate
  // functions: the salad can go on Thursday but is not what the meal *is*.
  assert.equal(isSuggestable("DINNER"), true);
  assert.equal(isSuggestable("SIDE"), false);
  assert.equal(isSuggestable("DRINK"), false);
  assert.equal(isSuggestable("DESSERT"), false);
});

test("anything suggestable is plannable", () => {
  // The card's one action is to put the recipe on a night. Offering something
  // the plan won't take would be a button that does nothing.
  for (const kind of RECIPE_KINDS) {
    if (isSuggestable(kind)) assert.ok(isPlannable(kind), `${kind} can't be planned`);
  }
});

test("a drink is made; everything else is served", () => {
  assert.equal(yieldNoun("DINNER"), "Serves");
  assert.equal(yieldNoun("DRINK"), "Makes");
  // A dessert and a side are portioned out to the people at the table, which
  // is the same question the dinner's number answers.
  assert.equal(yieldNoun("DESSERT"), "Serves");
  assert.equal(yieldNoun("SIDE"), "Serves");
});

test("every kind is named distinctly", () => {
  // Two tabs reading the same word is a tab strip nobody can use.
  const plurals = RECIPE_KINDS.map(kindPlural);
  assert.equal(new Set(plurals).size, plurals.length);
  const labels = RECIPE_KINDS.map(kindLabel);
  assert.equal(new Set(labels).size, labels.length);
});
