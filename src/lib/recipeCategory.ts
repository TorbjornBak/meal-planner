/**
 * What a recipe is made of (§2d) — the vocabulary behind "what shall we have?".
 *
 * "What shall we have?" is answered in two steps, and the library could only
 * ever help with the second. First comes a category — we had fish on Monday,
 * there's a vegetarian coming Thursday, tonight wants meat — and only then a
 * recipe. Searching for "torsk" (§2, `recipeSearch`) assumes you already know
 * you want cod, which is exactly the part you were stuck on.
 *
 * Four screens have to agree on what a category means: the review step, the
 * edit page, the library's filter and the dashboard's suggestions (§2e). They
 * agree here rather than each hard-coding "VEGETARIAN" and its wording,
 * because one of the rules is not obvious — a vegan dish satisfies a request
 * for vegetarian, and nothing else works that way — and a rule copied into
 * four files is a rule that will drift in three of them.
 *
 * Pure and dependency-free like the rest of the shared vocabulary (see
 * `recipeKind.ts`): no Prisma import, so it runs straight through Node under
 * `npm test`, with no generated client anywhere.
 */

/**
 * Every category, in the order the UI offers them.
 *
 * Ordered along one axis — most animal to least — rather than alphabetically,
 * so the row of filters reads as a scale a household can point at rather than
 * a bag of words. Fish before vegetarian also puts the two "not meat, not
 * plants" answers next to each other, which is how they get chosen.
 *
 * A `const` tuple, not a plain array, so it is three things at once: the list
 * the selects and chips are rendered from, the type below, and — handed to
 * `z.enum` in the recipe routes and the transfer schema — the API's
 * validation. One place to add a category.
 */
export const RECIPE_CATEGORIES = ["MEAT", "FISH", "VEGETARIAN", "VEGAN"] as const;

/** Mirrors the `RecipeCategory` enum in schema.prisma. */
export type RecipeCategory = (typeof RECIPE_CATEGORIES)[number];

/**
 * What the UI calls a recipe nobody has categorised yet.
 *
 * There is no NULL member of the enum, and there shouldn't be: "we haven't
 * said" is the absence of an answer, not one of the answers, and giving it a
 * value would let it be picked in a select and travel in an export as though
 * somebody had chosen it. It is a `null` category everywhere in the data, and
 * this string everywhere it is shown.
 */
export const UNCATEGORISED_LABEL = "Not said";

interface CategoryWords {
  /** The chip, the badge, the option: "Vegetarian". */
  label: string;
  /**
   * What it takes in, shown as the control's `title`. Every one of these
   * boundaries is a real question somebody asks the first time they file a
   * recipe — is chicken meat, are prawns fish, does butter break vegetarian —
   * and answering it in a tooltip is cheaper than four more enum values.
   */
  hint: string;
}

const WORDS: Record<RecipeCategory, CategoryWords> = {
  MEAT: {
    label: "Meat",
    hint: "Anything centred on meat, poultry included.",
  },
  FISH: {
    label: "Fish",
    hint: "Fish and shellfish.",
  },
  VEGETARIAN: {
    label: "Vegetarian",
    hint: "No meat or fish. Dairy and eggs are fine.",
  },
  VEGAN: {
    label: "Vegan",
    hint: "No animal products at all — also counts as vegetarian.",
  },
};

export function categoryLabel(category: RecipeCategory): string {
  return WORDS[category].label;
}

export function categoryHint(category: RecipeCategory): string {
  return WORDS[category].hint;
}

/** A recipe's category as it should be shown, including when there isn't one. */
export function categoryLabelOrUnset(category: RecipeCategory | null): string {
  return category ? categoryLabel(category) : UNCATEGORISED_LABEL;
}

/**
 * What the library's filter and the dashboard's suggestions can be set to: any
 * category, one category, or the recipes nobody has categorised.
 *
 * "UNSET" is a filter but not a category, which is the whole reason this type
 * exists separately from `RecipeCategory`. It is how you *find* the recipes
 * still needing an answer — otherwise a library that gained this field would
 * hold a growing, invisible pile of them.
 */
export type CategoryFilter = "ANY" | "UNSET" | RecipeCategory;

/** Every filter setting, in the order the controls offer them. */
export const CATEGORY_FILTERS = ["ANY", ...RECIPE_CATEGORIES, "UNSET"] as const;

export function categoryFilterLabel(filter: CategoryFilter): string {
  if (filter === "ANY") return "Any";
  if (filter === "UNSET") return UNCATEGORISED_LABEL;
  return categoryLabel(filter);
}

/**
 * Which filters a recipe of a given category answers to.
 *
 * Only one entry here is interesting, and it is the reason this is a table
 * rather than an `===`: **a vegan dish satisfies a request for vegetarian.**
 * Someone filtering for vegetarian is naming what they won't eat, not picking
 * a label, and hiding the dal because it happens to clear a higher bar is the
 * kind of wrong that makes people stop trusting the filter. The implication
 * runs one way only — asking for vegan and being handed an omelette is the
 * failure this whole field exists to prevent.
 *
 * Nothing else nests. Fish is not a kind of meat here, whatever a dictionary
 * says: a household that says "no meat tonight" and gets cod has been
 * understood, and one that says it and gets neither has lost a category.
 */
const SATISFIES: Record<RecipeCategory, readonly RecipeCategory[]> = {
  MEAT: ["MEAT"],
  FISH: ["FISH"],
  VEGETARIAN: ["VEGETARIAN"],
  VEGAN: ["VEGAN", "VEGETARIAN"],
};

/**
 * Whether a recipe belongs in a filtered list.
 *
 * Note what an uncategorised recipe does: it appears under "Any" and under
 * "Not said", and under nothing else. It is never quietly included in a
 * specific filter — offering an unlabelled dish to someone who asked for
 * vegetarian would be the app making the dietary claim, which is precisely
 * what the nullable column refuses to do (§2d).
 */
export function matchesCategoryFilter(
  category: RecipeCategory | null,
  filter: CategoryFilter,
): boolean {
  if (filter === "ANY") return true;
  if (filter === "UNSET") return category === null;
  if (category === null) return false;
  return SATISFIES[category].includes(filter);
}
