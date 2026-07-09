import { ingredientKey } from "./keys";
import { effectiveServings, scaleLine } from "./scaling";

/**
 * Shopping-list aggregation (§5).
 *
 * Given the week's dinner slots, produce one merged line per ingredient:
 *   - the same ingredient across dinners merges into a single line,
 *   - amounts sharing a unit are summed,
 *   - amounts whose units don't reconcile are shown as primary + alt rather
 *     than guessed at,
 *   - items whose name matches the pantry list are flagged (moved, not deleted).
 *
 * This is a pure function. Persisting the result and diffing it against a prior
 * list to preserve checked state lives in the API layer.
 */

export interface RecipeForList {
  statedServings: number;
  ingredients: { name: string; quantity: number | null; unit: string | null }[];
}

export interface SlotForList {
  recipe: RecipeForList | null;
  servingsOverride: number | null;
}

export interface AggregatedItem {
  ingredientKey: string;
  displayName: string;
  quantity: number | null;
  unit: string | null;
  /** Present only when a second, unreconciled unit exists for this ingredient. */
  altQuantity: number | null;
  altUnit: string | null;
  isPantry: boolean;
}

interface Bucket {
  quantity: number | null;
  unit: string | null;
}

export function aggregateShoppingList(
  slots: SlotForList[],
  householdSize: number,
  pantryKeys: Set<string>,
): AggregatedItem[] {
  // key -> { displayName, buckets keyed by normalized unit }
  const groups = new Map<
    string,
    { displayName: string; buckets: Map<string, Bucket> }
  >();

  for (const slot of slots) {
    if (!slot.recipe) continue; // empty night
    const target = effectiveServings(householdSize, slot.servingsOverride);

    for (const line of slot.recipe.ingredients) {
      const key = ingredientKey(line.name);
      const scaled = scaleLine(line, slot.recipe.statedServings, target);
      const unitKey = (scaled.unit ?? "").trim().toLowerCase();

      let group = groups.get(key);
      if (!group) {
        group = { displayName: line.name, buckets: new Map() };
        groups.set(key, group);
      }

      const existing = group.buckets.get(unitKey);
      if (!existing) {
        group.buckets.set(unitKey, { quantity: scaled.quantity, unit: scaled.unit });
      } else if (existing.quantity != null && scaled.quantity != null) {
        existing.quantity += scaled.quantity;
      } else {
        // "to taste" plus a measured amount: keep whichever amount we have.
        existing.quantity = existing.quantity ?? scaled.quantity;
      }
    }
  }

  const items: AggregatedItem[] = [];
  for (const [key, group] of groups) {
    const buckets = [...group.buckets.values()];
    const [primary, ...rest] = buckets;
    items.push({
      ingredientKey: key,
      displayName: group.displayName,
      quantity: primary?.quantity ?? null,
      unit: primary?.unit ?? null,
      // Show the first unreconciled alternative rather than guessing a
      // conversion. (Three+ distinct units for one ingredient is rare enough
      // to leave for a later refinement.)
      altQuantity: rest[0]?.quantity ?? null,
      altUnit: rest[0]?.unit ?? null,
      isPantry: pantryKeys.has(key),
    });
  }

  // Actionable items first, pantry items after, each alphabetical.
  items.sort((a, b) => {
    if (a.isPantry !== b.isPantry) return a.isPantry ? 1 : -1;
    return a.displayName.localeCompare(b.displayName);
  });

  return items;
}
