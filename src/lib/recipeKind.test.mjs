// Tests for the library's two sections (§2c). Run with `npm test`.
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

test("only dinners can go on a night", () => {
  // The plan is dinners only (§3). A picker that offers a flat white for
  // Tuesday is worse than no picker.
  assert.equal(isPlannable("DINNER"), true);
  assert.equal(isPlannable("DRINK"), false);
});

test("a drink is made, not served", () => {
  assert.equal(yieldNoun("DINNER"), "Serves");
  assert.equal(yieldNoun("DRINK"), "Makes");
});
