// Tests for the recipe library search (§2). Run with `npm test`.
//
// The library below is the shape the plan picker and the recipe list both hand
// in: Danish names with the letters that make folding interesting, plus an
// accented pair to prove ordinary diacritics still fall out of NFKD.

import test from "node:test";
import assert from "node:assert/strict";

import { foldForSearch, searchRecipes } from "./recipeSearch.ts";

const LIBRARY = [
  {
    id: "rodgrod",
    name: "Rødgrød med fløde",
    ingredients: [{ name: "Jordbær" }, { name: "Rabarber" }, { name: "Sukker" }],
  },
  {
    id: "gratin",
    name: "Blomkålsgratin",
    ingredients: [{ name: "Blomkål" }, { name: "Fløde" }, { name: "Revet ost" }],
  },
  {
    id: "karry",
    name: "Kylling i karry",
    ingredients: [
      { name: "Kyllingebryst" },
      { name: "Rødløg" },
      { name: "Karrypulver" },
    ],
  },
  {
    id: "puree",
    name: "Pea purée",
    ingredients: [{ name: "Ærter" }, { name: "Créme fraîche" }],
  },
];

const ids = (results) => results.map((m) => m.recipe.id);

test("the Danish letters fold to what you'd type without them", () => {
  assert.equal(foldForSearch("Rødgrød"), "rodgrod");
  assert.equal(foldForSearch("Blåbær"), "blaabaer");
  // NFKD handles the rest: a base letter plus a combining mark.
  assert.equal(foldForSearch("Purée"), "puree");
  assert.equal(foldForSearch("  Revet   ost "), "revet ost");
});

test("Danish folding works from both sides of the keyboard", () => {
  // Typed without the letters…
  assert.deepEqual(ids(searchRecipes(LIBRARY, "rodgrod")), ["rodgrod"]);
  // …and typed with them. Both fold to the same thing, so both find it.
  assert.deepEqual(ids(searchRecipes(LIBRARY, "rødgrød")), ["rodgrod"]);

  // æ and å, on an ingredient rather than a name.
  assert.deepEqual(ids(searchRecipes(LIBRARY, "jordbaer")), ["rodgrod"]);
  assert.deepEqual(ids(searchRecipes(LIBRARY, "jordbær")), ["rodgrod"]);
  assert.deepEqual(ids(searchRecipes(LIBRARY, "blomkaal")), ["gratin"]);
  assert.deepEqual(ids(searchRecipes(LIBRARY, "blomkål")), ["gratin"]);
});

test("a term matches inside a word, not just at its start", () => {
  // "løg" is buried in "Rødløg" — the fold must not go stemming or tokenizing.
  assert.deepEqual(ids(searchRecipes(LIBRARY, "løg")), ["karry"]);
});

test("terms are ANDed, and may land in different places", () => {
  // "flode" is in the gratin's ingredients and in the rødgrød's *name*; only
  // the gratin also has an "ost".
  assert.deepEqual(ids(searchRecipes(LIBRARY, "flode ost")), ["gratin"]);
  // One term hits the name, the other an ingredient.
  assert.deepEqual(ids(searchRecipes(LIBRARY, "kylling rodlog")), ["karry"]);
  // Every term has to hit something.
  assert.deepEqual(ids(searchRecipes(LIBRARY, "kylling rabarber")), []);
});

test("a name-only hit reports no matched ingredients", () => {
  const [match] = searchRecipes(LIBRARY, "gratin");
  assert.equal(match.recipe.id, "gratin");
  assert.deepEqual(match.matchedIngredients, []);
});

test("an ingredient-only hit says which ingredients it was", () => {
  const [match] = searchRecipes(LIBRARY, "rabarber");
  assert.equal(match.recipe.id, "rodgrod");
  assert.deepEqual(match.matchedIngredients, ["Rabarber"]);

  // Several matched ingredients come back in the recipe's own order, spelled
  // the way the recipe spells them — this is what the picker shows you.
  const [gratin] = searchRecipes(LIBRARY, "flode ost");
  assert.deepEqual(gratin.matchedIngredients, ["Fløde", "Revet ost"]);
});

test("an empty query is the whole library, in the order it came in", () => {
  assert.deepEqual(ids(searchRecipes(LIBRARY, "")), [
    "rodgrod",
    "gratin",
    "karry",
    "puree",
  ]);
  // Whitespace is not a query either.
  assert.deepEqual(ids(searchRecipes(LIBRARY, "   ")), [
    "rodgrod",
    "gratin",
    "karry",
    "puree",
  ]);
  // Nothing is highlighted as a reason, because nothing was asked for.
  for (const m of searchRecipes(LIBRARY, "")) {
    assert.deepEqual(m.matchedIngredients, []);
  }
});

test("ordinary accents are ignored on both sides", () => {
  assert.deepEqual(ids(searchRecipes(LIBRARY, "puree")), ["puree"]);
  assert.deepEqual(ids(searchRecipes(LIBRARY, "creme fraiche")), ["puree"]);
});

test("no match is an empty list, not everything", () => {
  assert.deepEqual(searchRecipes(LIBRARY, "lakrids"), []);
});
