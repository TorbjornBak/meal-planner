import type { AggregatedItem } from "./shopping";

/**
 * Reconciling hand-added shopping-list lines with a regenerated one (§5, §6).
 *
 * `aggregateShoppingList` answers "what do the week's dinners need?", and
 * deliberately knows nothing about persistence. But the list you carry round
 * the shop also holds things no recipe ever mentions — kitchen roll, nappies,
 * milk — and regeneration used to delete every row and rebuild it from the
 * plan, which is precisely why the household kept a second list on a phone.
 *
 * This module is the small decision in the middle: given the freshly
 * aggregated lines and the rows already on the list, work out the exact set of
 * rows the list should end up with. It's pure so the collision case below can
 * be tested without a database; the API layer does the deleting and inserting.
 */

/** The columns of an existing row that this decision actually reads. */
export interface ExistingItem {
  ingredientKey: string;
  displayName: string;
  quantity: number | null;
  unit: string | null;
  altQuantity: number | null;
  altUnit: string | null;
  checked: boolean;
  isPantry: boolean;
  isManual: boolean;
}

/** A row to write back to the list, in the order it should be shown. */
export type ListRow = ExistingItem;

/**
 * The full row set for a regenerated list: every aggregated line, plus the
 * manual lines that aren't accounted for by a recipe.
 *
 * The collision case is the interesting one. `ShoppingListItem` is unique on
 * (list, ingredientKey), so a hand-typed "milk" and a milk that arrived with
 * Wednesday's gratin cannot both exist — and since manual names are normalized
 * with the same `ingredientKey` as recipe lines, they collide often and on
 * purpose. We **merge**: the derived line wins (it carries the amounts the
 * recipes actually call for), the checked state comes across so an item you
 * already grabbed doesn't un-tick itself mid-shop, and the manual flag is
 * dropped — the milk is now on the list because a dinner needs it, and if that
 * dinner leaves the plan the line should leave with it. The alternative,
 * keeping the manual row and discarding the recipe's amounts, would quietly
 * under-buy.
 *
 * Merging here is also what stops the insert from throwing: no key is ever
 * emitted twice.
 */
export function mergeManualItems(
  aggregated: AggregatedItem[],
  existing: ExistingItem[],
): ListRow[] {
  // Checked state carries across regeneration by key, from manual rows as well
  // as derived ones — that carry-over *is* half of the merge.
  const checkedByKey = new Map(existing.map((i) => [i.ingredientKey, i.checked]));
  const derivedKeys = new Set(aggregated.map((a) => a.ingredientKey));

  const rows: ListRow[] = aggregated.map((a) => ({
    ingredientKey: a.ingredientKey,
    displayName: a.displayName,
    quantity: a.quantity,
    unit: a.unit,
    altQuantity: a.altQuantity,
    altUnit: a.altUnit,
    checked: checkedByKey.get(a.ingredientKey) ?? false,
    isPantry: a.isPantry,
    // Anything a recipe asks for is derived, whether or not it was typed in by
    // hand first. This is the "clear the manual flag" half of the merge.
    isManual: false,
  }));

  for (const item of existing) {
    if (!item.isManual) continue; // derived rows are rebuilt from the plan
    if (derivedKeys.has(item.ingredientKey)) continue; // merged above
    // Re-emitted verbatim, `isPantry` included. A manual line that matches a
    // pantry staple stays where the household put it: typing "salt" onto the
    // list is the "we've actually run out" signal §5 talks about, and quietly
    // filing it back under "check you have these" would throw that away.
    rows.push({ ...item });
  }

  // Same order as aggregateShoppingList: actionable first, pantry after, each
  // alphabetical. Manual lines interleave with derived ones rather than being
  // exiled to the bottom — in the shop they're all just things to pick up; the
  // UI marks which is which.
  rows.sort((a, b) => {
    if (a.isPantry !== b.isPantry) return a.isPantry ? 1 : -1;
    return a.displayName.localeCompare(b.displayName);
  });

  return rows;
}
