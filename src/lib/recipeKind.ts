/**
 * Dinner or drink (§2c).
 *
 * The library holds two kinds of recipe now, and five screens have to agree on
 * what that means: the library's own two sections, the add and edit forms, the
 * plan page's picker, and the weekly digest. They agree here rather than each
 * hard-coding the string "DRINK" and its wording, because the wording is not
 * uniform — a stew *serves* four, a cortado *makes* one — and a copy of that
 * rule in five files is a copy that will drift.
 *
 * Pure and dependency-free, like the rest of the shared vocabulary: no Prisma
 * import, so the email composer (which runs straight through Node under `npm
 * test`, with no generated client anywhere) can use it too.
 */

/**
 * Every kind, in the order the library shows them.
 *
 * Dinner first, and not alphabetically: dinner is what the app is for (§3), and
 * the section a household opens twenty times a week shouldn't move because
 * someone later adds a "BAKING".
 *
 * A `const` tuple, not a plain array, so it is three things at once: the list
 * the tabs are rendered from, the type below, and — handed straight to
 * `z.enum` in the two recipe routes — the API's validation. One place to add a
 * kind.
 */
export const RECIPE_KINDS = ["DINNER", "DRINK"] as const;

/** Mirrors the `RecipeKind` enum in schema.prisma. */
export type RecipeKind = (typeof RECIPE_KINDS)[number];

/** The default for anything that doesn't say — matching the column's default. */
export const DEFAULT_RECIPE_KIND: RecipeKind = "DINNER";

interface KindWords {
  /** One of them: "Dinner". */
  one: string;
  /** The section heading and the tab: "Dinners". */
  many: string;
  /**
   * What its serving count is called. A recipe states how much it produces,
   * but a dish produces portions and a drink produces cups — "Serves 1" on a
   * cortado reads like an apology.
   */
  yield: string;
  /** The line shown when that section is empty. */
  empty: string;
}

const WORDS: Record<RecipeKind, KindWords> = {
  DINNER: {
    one: "Dinner",
    many: "Dinners",
    yield: "Serves",
    empty: "No dinners saved yet.",
  },
  DRINK: {
    one: "Drink",
    many: "Drinks",
    yield: "Makes",
    empty: "No drinks yet — coffee ratios, cordials, gløgg.",
  },
};

export function kindLabel(kind: RecipeKind): string {
  return WORDS[kind].one;
}

export function kindPlural(kind: RecipeKind): string {
  return WORDS[kind].many;
}

/** "Serves 4" / "Makes 2" — the verb, without the number. */
export function yieldNoun(kind: RecipeKind): string {
  return WORDS[kind].yield;
}

export function emptyKindLine(kind: RecipeKind): string {
  return WORDS[kind].empty;
}

/**
 * Whether a recipe of this kind can go on a night of the plan (§3).
 *
 * The plan is dinners only and stays that way — this is the one question the
 * picker and the library's "Add to plan" control both ask, and the reason the
 * kind is an enum column rather than a tag: a control that offers to put a
 * flat white on Tuesday is worse than no control.
 *
 * Note the consequence, which is deliberate: a drink is never on a week, so its
 * ingredients never reach the aggregated shopping list (§5) and it never gets a
 * "last cooked" week (§2). Coffee beans go on the list by hand, like kitchen
 * roll (§5, manual items).
 */
export function isPlannable(kind: RecipeKind): boolean {
  return kind === "DINNER";
}
