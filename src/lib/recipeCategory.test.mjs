// Tests for what a recipe is made of (§2d). Run with `npm test`.
//
// Two things are worth testing here and they are not the same thing. One is
// the lookup table, whose failure mode is a missing answer rather than a wrong
// one — somebody adds a category, wires up the chip, and finds out on the
// recipe page that it has no hint. The other is the one real rule in the
// module: a vegan dish counts as vegetarian, and the implication runs one way.

import test from "node:test";
import assert from "node:assert/strict";

import {
  CATEGORY_FILTERS,
  RECIPE_CATEGORIES,
  UNCATEGORISED_LABEL,
  categoryFilterLabel,
  categoryHint,
  categoryLabel,
  categoryLabelOrUnset,
  matchesCategoryFilter,
} from "./recipeCategory.ts";

test("every category has every word the UI asks it for", () => {
  for (const category of RECIPE_CATEGORIES) {
    for (const [what, word] of [
      ["label", categoryLabel(category)],
      ["hint", categoryHint(category)],
    ]) {
      assert.equal(typeof word, "string", `${category} has no ${what}`);
      assert.ok(word.length > 0, `${category}'s ${what} is empty`);
    }
  }
});

test("every filter — including the two that aren't categories — has a label", () => {
  for (const filter of CATEGORY_FILTERS) {
    const label = categoryFilterLabel(filter);
    assert.equal(typeof label, "string", `${filter} has no label`);
    assert.ok(label.length > 0, `${filter}'s label is empty`);
  }
});

test("a category answers to itself and to Any", () => {
  for (const category of RECIPE_CATEGORIES) {
    assert.equal(matchesCategoryFilter(category, category), true);
    assert.equal(matchesCategoryFilter(category, "ANY"), true);
  }
});

test("vegan counts as vegetarian, and vegetarian does not count as vegan", () => {
  // The one rule in the module. Someone filtering for vegetarian is naming
  // what they won't eat, so the dal belongs in that list...
  assert.equal(matchesCategoryFilter("VEGAN", "VEGETARIAN"), true);
  // ...but the implication runs one way only. Asking for vegan and being
  // handed an omelette is the failure the field exists to prevent.
  assert.equal(matchesCategoryFilter("VEGETARIAN", "VEGAN"), false);
});

test("fish is not a kind of meat, nor meat a kind of fish", () => {
  // A household that says "no meat tonight" and gets cod has been understood.
  assert.equal(matchesCategoryFilter("FISH", "MEAT"), false);
  assert.equal(matchesCategoryFilter("MEAT", "FISH"), false);
  // And neither is a vegetable.
  assert.equal(matchesCategoryFilter("FISH", "VEGETARIAN"), false);
  assert.equal(matchesCategoryFilter("MEAT", "VEGAN"), false);
});

test("an uncategorised recipe is never claimed to be anything", () => {
  // It shows up in the two places that make no claim about it...
  assert.equal(matchesCategoryFilter(null, "ANY"), true);
  assert.equal(matchesCategoryFilter(null, "UNSET"), true);
  // ...and in none of the ones that do. Offering an unlabelled dish to someone
  // who asked for vegetarian would be the app inventing a dietary claim (§2d).
  for (const category of RECIPE_CATEGORIES) {
    assert.equal(
      matchesCategoryFilter(null, category),
      false,
      `null was offered as ${category}`,
    );
  }
});

test("a categorised recipe is never mistaken for an uncategorised one", () => {
  // Otherwise "Not said" — the list you work through to fix the library —
  // would never empty.
  for (const category of RECIPE_CATEGORIES) {
    assert.equal(matchesCategoryFilter(category, "UNSET"), false);
  }
});

test("the missing answer is shown as missing, not as a category", () => {
  assert.equal(categoryLabelOrUnset(null), UNCATEGORISED_LABEL);
  assert.equal(categoryLabelOrUnset("VEGAN"), "Vegan");
});

test("Any leads the filters and Not said trails them", () => {
  // The default is no filter, and the tidy-up list is not something you scroll
  // past on the way to the categories.
  assert.equal(CATEGORY_FILTERS[0], "ANY");
  assert.equal(CATEGORY_FILTERS[CATEGORY_FILTERS.length - 1], "UNSET");
});
