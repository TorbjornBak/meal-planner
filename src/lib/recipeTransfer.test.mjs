// Tests for the recipe transfer file (§2, §11). Run with `npm test`.
//
// The export shape and the import validation are one contract seen from two
// sides, so the test that matters most is the round trip: take a row out of the
// library, serialise it exactly as the export route would (JSON.stringify and
// back, so nothing survives on a shared object reference), read it back in, and
// check that what lands in `prisma.recipe.create` is what set out. Anything the
// two sides quietly disagree about shows up here rather than in someone's
// library six months from now.

import test from "node:test";
import assert from "node:assert/strict";

import {
  TRANSFER_FORMAT,
  TRANSFER_VERSION,
  buildTransferFile,
  parseTransferFile,
  planImport,
  toRecipeCreateData,
  toTransferRecipe,
  transferFilename,
  transferKey,
} from "./recipeTransfer.ts";

/** A library row, with the boring fields filled in. */
function row(over = {}) {
  return {
    name: "Lasagne",
    kind: "DINNER",
    category: "MEAT",
    source: "https://example.test/lasagne",
    statedServings: 4,
    instructions: "Brown the mince. Bake 40 minutes.",
    tags: ["pasta", "weekend"],
    totalTimeMinutes: 90,
    totalTimeIsEstimate: false,
    ingredients: [
      { name: "Minced beef", quantity: 500, unit: "g", position: 0 },
      { name: "Onion", quantity: 2, unit: null, position: 1 },
    ],
    ...over,
  };
}

/** What the export route puts on the wire, as the import route receives it. */
function throughTheWire(rows, exportedAt = new Date("2026-08-28T10:00:00.000Z")) {
  return JSON.parse(JSON.stringify(buildTransferFile(rows, exportedAt)));
}

// --- The envelope ------------------------------------------------------------

test("the file names its format and version, and dates itself", () => {
  const file = throughTheWire([row()]);
  assert.equal(file.format, TRANSFER_FORMAT);
  assert.equal(file.version, TRANSFER_VERSION);
  assert.equal(file.exportedAt, "2026-08-28T10:00:00.000Z");
  assert.equal(file.recipes.length, 1);
});

test("the download is named after the day it was taken", () => {
  assert.equal(
    transferFilename(new Date("2026-08-28T22:30:00.000Z")),
    "mealplanner-recipes-2026-08-28.json",
  );
});

test("photos are left out of the file entirely", () => {
  // The bytes and the hotlink both stay behind (§2b) — see toTransferRecipe.
  const exported = toTransferRecipe(
    row({ image: new Uint8Array([1, 2, 3]), imageMime: "image/jpeg", imageUrl: "https://x.test/a.jpg" }),
  );
  assert.equal("image" in exported, false);
  assert.equal("imageMime" in exported, false);
  assert.equal("imageUrl" in exported, false);
});

// --- Round trip --------------------------------------------------------------

test("a recipe survives export and re-import unchanged", () => {
  const parsed = parseTransferFile(throughTheWire([row()]));
  assert.equal(parsed.ok, true);

  const data = toRecipeCreateData(parsed.file.recipes[0]);
  assert.equal(data.name, "Lasagne");
  assert.equal(data.source, "https://example.test/lasagne");
  assert.equal(data.statedServings, 4);
  assert.equal(data.instructions, "Brown the mince. Bake 40 minutes.");
  assert.deepEqual(data.tags, ["pasta", "weekend"]);
  assert.equal(data.category, "MEAT");
  assert.equal(data.totalTimeMinutes, 90);
  assert.deepEqual(data.ingredients.create, [
    { name: "Minced beef", quantity: 500, unit: "g", position: 0 },
    { name: "Onion", quantity: 2, unit: null, position: 1 },
  ]);
});

test("an estimated cook time comes back still marked as an estimate", () => {
  // Losing this flag would promote our arithmetic to the recipe's own claim, and
  // the receiving library would print "about 40 min" as a flat 40.
  const parsed = parseTransferFile(
    throughTheWire([row({ totalTimeMinutes: 40, totalTimeIsEstimate: true })]),
  );
  assert.equal(parsed.ok, true);
  const data = toRecipeCreateData(parsed.file.recipes[0]);
  assert.equal(data.totalTimeMinutes, 40);
  assert.equal(data.totalTimeIsEstimate, true);
});

test("a stated cook time is not turned into an estimate on the way through", () => {
  const parsed = parseTransferFile(throughTheWire([row()]));
  assert.equal(toRecipeCreateData(parsed.file.recipes[0]).totalTimeIsEstimate, false);
});

test("a recipe nobody has ever timed keeps its empty cook time", () => {
  const parsed = parseTransferFile(
    throughTheWire([row({ totalTimeMinutes: null, totalTimeIsEstimate: false })]),
  );
  assert.equal(parsed.ok, true);
  assert.equal(toRecipeCreateData(parsed.file.recipes[0]).totalTimeMinutes, null);
});

test("a recipe with no source and no instructions still round-trips", () => {
  const parsed = parseTransferFile(
    throughTheWire([row({ source: null, instructions: null, tags: [] })]),
  );
  assert.equal(parsed.ok, true);
  const data = toRecipeCreateData(parsed.file.recipes[0]);
  assert.equal(data.source, null);
  assert.equal(data.instructions, null);
  assert.deepEqual(data.tags, []);
});

// --- Ingredient ordering -----------------------------------------------------

test("ingredients come out in position order, whatever order the rows arrive in", () => {
  const exported = toTransferRecipe(
    row({
      ingredients: [
        { name: "Salt", quantity: null, unit: null, position: 2 },
        { name: "Flour", quantity: 200, unit: "g", position: 0 },
        { name: "Butter", quantity: 50, unit: "g", position: 1 },
      ],
    }),
  );
  assert.deepEqual(
    exported.ingredients.map((i) => i.name),
    ["Flour", "Butter", "Salt"],
  );
});

test("array order becomes position again on the way back in", () => {
  const parsed = parseTransferFile(
    throughTheWire([
      row({
        ingredients: [
          { name: "Salt", quantity: null, unit: null, position: 7 },
          { name: "Flour", quantity: 200, unit: "g", position: 3 },
        ],
      }),
    ]),
  );
  assert.equal(parsed.ok, true);
  // Sparse source positions (7, 3) come back as a clean 0, 1 in cooking order.
  assert.deepEqual(toRecipeCreateData(parsed.file.recipes[0]).ingredients.create, [
    { name: "Flour", quantity: 200, unit: "g", position: 0 },
    { name: "Salt", quantity: null, unit: null, position: 1 },
  ]);
});

// --- "To taste" lines --------------------------------------------------------

test("a null quantity and unit survive rather than becoming zero", () => {
  // "Salt, to taste" is a real line (§1). A 0 here would scale into the shopping
  // list as an amount, which is exactly the wrong answer.
  const parsed = parseTransferFile(
    throughTheWire([
      row({ ingredients: [{ name: "Salt", quantity: null, unit: null, position: 0 }] }),
    ]),
  );
  assert.equal(parsed.ok, true);
  const line = toRecipeCreateData(parsed.file.recipes[0]).ingredients.create[0];
  assert.equal(line.quantity, null);
  assert.equal(line.unit, null);
});

test("a hand-written file may leave quantity and unit off a to-taste line", () => {
  const parsed = parseTransferFile({
    format: TRANSFER_FORMAT,
    version: 1,
    recipes: [
      { name: "Boiled eggs", statedServings: 2, ingredients: [{ name: "Salt" }] },
    ],
  });
  assert.equal(parsed.ok, true);
  const data = toRecipeCreateData(parsed.file.recipes[0]);
  assert.deepEqual(data.ingredients.create, [
    { name: "Salt", quantity: null, unit: null, position: 0 },
  ]);
  // The optional recipe fields fall back the same way.
  assert.equal(data.source, null);
  assert.equal(data.totalTimeIsEstimate, false);
  assert.deepEqual(data.tags, []);
});

// --- Malformed input ---------------------------------------------------------

test("a JSON file that isn't ours is named as such", () => {
  const parsed = parseTransferFile({ some: "other export" });
  assert.equal(parsed.ok, false);
  assert.match(parsed.message, /isn't a MealPlanner recipe export/);
});

test("a bare array is rejected before anything looks for recipes in it", () => {
  const parsed = parseTransferFile([{ name: "Lasagne" }]);
  assert.equal(parsed.ok, false);
  assert.match(parsed.message, /JSON object/);
});

test("a file from a future version says so instead of half-reading it", () => {
  const parsed = parseTransferFile({
    format: TRANSFER_FORMAT,
    version: TRANSFER_VERSION + 1,
    recipes: [],
  });
  assert.equal(parsed.ok, false);
  assert.match(parsed.message, /version 2/);
  assert.match(parsed.message, /Update MealPlanner/);
});

test("a broken recipe is reported by name, not by position in a list", () => {
  const parsed = parseTransferFile({
    format: TRANSFER_FORMAT,
    version: 1,
    recipes: [
      row({ ingredients: [] }),
      { name: "Frikadeller", statedServings: 0, ingredients: [] },
    ],
  });
  assert.equal(parsed.ok, false);
  assert.match(parsed.message, /Frikadeller/);
  assert.match(parsed.message, /statedServings/);
});

test("a recipe with no name at all is still pinpointed", () => {
  const parsed = parseTransferFile({
    format: TRANSFER_FORMAT,
    version: 1,
    recipes: [{ statedServings: 2, ingredients: [] }],
  });
  assert.equal(parsed.ok, false);
  assert.match(parsed.message, /number 1/);
});

test("recipes must be a list, and saying so beats a schema dump", () => {
  const parsed = parseTransferFile({ format: TRANSFER_FORMAT, version: 1, recipes: "lots" });
  assert.equal(parsed.ok, false);
  assert.match(parsed.message, /recipes/);
});

test("an empty library exports and imports as an empty library", () => {
  const parsed = parseTransferFile(throughTheWire([]));
  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.file.recipes, []);
});

// --- Duplicates --------------------------------------------------------------

test("the duplicate key ignores case and stray whitespace", () => {
  assert.equal(
    transferKey("  Lasagne  ", "https://Example.test/x"),
    transferKey("lasagne", "https://example.test/x"),
  );
  assert.equal(transferKey("Fiske  gratin", null), transferKey("fiske gratin", null));
});

test("the same name from a different source is a different recipe", () => {
  assert.notEqual(
    transferKey("Lasagne", "https://a.test/l"),
    transferKey("Lasagne", "https://b.test/l"),
  );
  assert.notEqual(transferKey("Lasagne", null), transferKey("Lasagne", "https://a.test/l"));
});

test("re-importing the same file adds nothing the second time", () => {
  const file = parseTransferFile(throughTheWire([row(), row({ name: "Frikadeller" })]));
  assert.equal(file.ok, true);

  const first = planImport(file.file.recipes, []);
  assert.equal(first.toCreate.length, 2);
  assert.equal(first.skipped.length, 0);

  const existing = first.toCreate.map((r) => transferKey(r.name, r.source));
  const second = planImport(file.file.recipes, existing);
  assert.equal(second.toCreate.length, 0);
  assert.equal(second.skipped.length, 2);
});

test("a file carrying the same recipe twice only imports it once", () => {
  const { toCreate, skipped } = planImport(
    [row(), row(), row({ name: "Frikadeller" })].map(toTransferRecipe),
    [],
  );
  assert.deepEqual(
    toCreate.map((r) => r.name),
    ["Lasagne", "Frikadeller"],
  );
  assert.equal(skipped.length, 1);
});

// --- Dinner or drink (§2c) ---------------------------------------------------

test("a drink crosses the wire as a drink", () => {
  const file = throughTheWire([row({ name: "Cortado", kind: "DRINK", statedServings: 1 })]);
  assert.equal(file.recipes[0].kind, "DRINK");

  const parsed = parseTransferFile(file);
  assert.equal(parsed.ok, true);
  assert.equal(toRecipeCreateData(parsed.file.recipes[0]).kind, "DRINK");
});

test("a file written before drinks existed imports as dinners", () => {
  // Exactly what an older instance produced: no `kind` key anywhere.
  const file = throughTheWire([row()]);
  delete file.recipes[0].kind;

  const parsed = parseTransferFile(file);
  assert.equal(parsed.ok, true);
  assert.equal(toRecipeCreateData(parsed.file.recipes[0]).kind, "DINNER");
});

test("a kind this version has never heard of is refused by name, not silently taken", () => {
  const file = throughTheWire([row()]);
  file.recipes[0].kind = "BAKING";

  const parsed = parseTransferFile(file);
  assert.equal(parsed.ok, false);
  assert.match(parsed.message, /Lasagne/);
  assert.match(parsed.message, /kind/);
});

// --- What it's made of (§2d) -------------------------------------------------

test("a category crosses the wire intact", () => {
  const file = throughTheWire([row({ name: "Dal", category: "VEGAN" })]);
  assert.equal(file.recipes[0].category, "VEGAN");

  const parsed = parseTransferFile(file);
  assert.equal(parsed.ok, true);
  assert.equal(toRecipeCreateData(parsed.file.recipes[0]).category, "VEGAN");
});

test("a file written before categories existed imports as uncategorised", () => {
  // Exactly what an older instance produced: no `category` key anywhere. The
  // receiving library must say "not said" rather than pick one — an invented
  // dietary claim is worse than an absent one (§2d).
  const file = throughTheWire([row()]);
  delete file.recipes[0].category;

  const parsed = parseTransferFile(file);
  assert.equal(parsed.ok, true);
  assert.equal(toRecipeCreateData(parsed.file.recipes[0]).category, null);
});

test("a recipe nobody categorised stays uncategorised through the round trip", () => {
  const parsed = parseTransferFile(throughTheWire([row({ category: null })]));
  assert.equal(parsed.ok, true);
  assert.equal(toRecipeCreateData(parsed.file.recipes[0]).category, null);
});

test("a category this version has never heard of is refused, not dropped", () => {
  // The tempting alternative — default the unknown value to null — would throw
  // away the one claim the field exists to carry, and do it silently.
  const file = throughTheWire([row()]);
  file.recipes[0].category = "PESCATARIAN";

  const parsed = parseTransferFile(file);
  assert.equal(parsed.ok, false);
  assert.match(parsed.message, /Lasagne/);
  assert.match(parsed.message, /category/);
});
