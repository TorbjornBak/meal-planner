// Tests for the manual/derived reconciliation on the shopping list (§5, §6).
// Run with `npm test`.
//
// The cases that matter are the ones the API layer can't easily be poked at
// for: what survives a regeneration, and what happens when a line someone
// typed in by hand turns out to be an ingredient after all.

import test from "node:test";
import assert from "node:assert/strict";

import { mergeManualItems } from "./manualItems.ts";

/** An aggregated (recipe-derived) line, with the boring fields filled in. */
function derived(displayName, over = {}) {
  return {
    ingredientKey: displayName.toLowerCase(),
    displayName,
    quantity: null,
    unit: null,
    altQuantity: null,
    altUnit: null,
    isPantry: false,
    ...over,
  };
}

/** A row already on the list. */
function row(displayName, over = {}) {
  return {
    ingredientKey: displayName.toLowerCase(),
    displayName,
    quantity: null,
    unit: null,
    altQuantity: null,
    altUnit: null,
    checked: false,
    isPantry: false,
    isManual: false,
    ...over,
  };
}

const byKey = (rows) => new Map(rows.map((r) => [r.ingredientKey, r]));

test("manual lines survive a regeneration that has nothing to do with them", () => {
  const out = mergeManualItems(
    [derived("Onion")],
    [row("Kitchen roll", { isManual: true }), row("Onion")],
  );
  const kitchenRoll = byKey(out).get("kitchen roll");
  assert.ok(kitchenRoll, "the hand-added line is still on the list");
  assert.equal(kitchenRoll.isManual, true);
});

test("a manual line comes back untouched, checked state and all", () => {
  const nappies = row("Nappies", {
    isManual: true,
    checked: true,
    quantity: 2,
    unit: "pack",
    isPantry: true,
  });
  const [out] = mergeManualItems([], [nappies]);
  assert.deepEqual(out, nappies);
});

test("derived lines are rebuilt from the plan, not carried over", () => {
  // Last week's onion is gone from the plan, so it drops off the list.
  const out = mergeManualItems([derived("Leek")], [row("Onion")]);
  assert.deepEqual(
    out.map((r) => r.displayName),
    ["Leek"],
  );
});

test("checked state still carries across for derived lines", () => {
  const [out] = mergeManualItems([derived("Onion")], [row("Onion", { checked: true })]);
  assert.equal(out.checked, true);
});

test("a manual line that a recipe now needs merges into the derived one", () => {
  const out = mergeManualItems(
    [derived("Milk", { quantity: 500, unit: "ml" })],
    [row("Milk", { isManual: true, checked: true })],
  );
  // One line, not two — the unique key on (list, ingredientKey) would refuse
  // the second insert anyway.
  assert.equal(out.length, 1);
  const [milk] = out;
  assert.equal(milk.isManual, false, "it's on the list because a dinner needs it now");
  assert.equal(milk.quantity, 500, "the recipe's amount wins over the bare manual line");
  assert.equal(milk.checked, true, "already grabbed stays grabbed");
});

test("no key is ever emitted twice, whatever the overlap", () => {
  const out = mergeManualItems(
    [derived("Milk"), derived("Onion")],
    [
      row("Milk", { isManual: true }),
      row("Onion"),
      row("Kitchen roll", { isManual: true }),
    ],
  );
  const keys = out.map((r) => r.ingredientKey);
  assert.equal(new Set(keys).size, keys.length);
});

test("pantry lines sort last, everything else alphabetically", () => {
  const out = mergeManualItems(
    [derived("Onion"), derived("Salt", { isPantry: true }), derived("Apple")],
    [row("Kitchen roll", { isManual: true })],
  );
  assert.deepEqual(
    out.map((r) => r.displayName),
    ["Apple", "Kitchen roll", "Onion", "Salt"],
  );
});

test("an empty plan leaves a list of nothing but hand-added things", () => {
  const out = mergeManualItems([], [row("Onion"), row("Nappies", { isManual: true })]);
  assert.deepEqual(
    out.map((r) => r.displayName),
    ["Nappies"],
  );
});
