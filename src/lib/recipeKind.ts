/**
 * What a recipe is: a dinner, something served alongside one, a drink or a
 * dessert (§2c).
 *
 * The library holds four kinds of recipe now, and five screens have to agree
 * on what that means: the library's own sections, the add and edit forms, the
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
 * someone later adds a "BAKING". Sides next, because they are the other half of
 * the same question — a main and what goes with it — and the only other kind
 * that reaches a night. Then the courses the plan doesn't hold.
 *
 * A `const` tuple, not a plain array, so it is three things at once: the list
 * the tabs are rendered from, the type below, and — handed straight to
 * `z.enum` in the two recipe routes — the API's validation. One place to add a
 * kind.
 */
export const RECIPE_KINDS = ["DINNER", "SIDE", "DESSERT", "DRINK"] as const;

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
  SIDE: {
    // "Side" rather than "Salad": a salad is one, and so are the potatoes, the
    // flatbread and the pickled cucumber. Named for the job it does at the
    // table, which is the thing being looked for.
    one: "Side",
    many: "Sides",
    yield: "Serves",
    empty: "No sides yet — salads, potatoes, the bread that goes with.",
  },
  DRINK: {
    one: "Drink",
    many: "Drinks",
    yield: "Makes",
    empty: "No drinks yet — coffee ratios, cordials, gløgg.",
  },
  DESSERT: {
    // "Serves", like a dinner and unlike a drink: a dessert is portioned out
    // to the people at the table, which is the question the number answers.
    // Scaling a trifle for six is the same arithmetic as scaling a stew.
    one: "Dessert",
    many: "Desserts",
    yield: "Serves",
    empty: "No desserts yet — cakes, ice cream, risalamande.",
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
 * Dinners and sides, because a night is a meal: the roast and the salad that
 * goes with it are both cooked on Thursday, and both need buying for. Saying no
 * to the salad here would keep it off the night picker *and* out of the
 * aggregated shopping list (§5), which is the whole reason the plan holds
 * recipes rather than names.
 *
 * Note the consequence for the two kinds this excludes, which is deliberate: a
 * drink or a dessert is never on a week, so its ingredients never reach the
 * shopping list and it never gets a "last cooked" week (§2). Coffee beans and
 * vanilla pods go on the list by hand, like kitchen roll (§5, manual items).
 */
export function isPlannable(kind: RecipeKind): boolean {
  return kind === "DINNER" || kind === "SIDE";
}

/**
 * Whether a recipe of this kind is an answer to "what shall we have?" (§2e).
 *
 * Narrower than `isPlannable`, and the two came apart the moment sides existed.
 * A side can be put on Thursday, so the picker offers it and the shopping list
 * buys for it; but the dashboard is asking what the *meal* is, and a card that
 * comes back with two stews and a green salad has answered a question nobody
 * asked. You reach for a side once you know what it is going next to.
 *
 * Written as "is it dinner" rather than as a list of what's excluded, so a kind
 * added tomorrow is unsuggestable until somebody decides otherwise — the safe
 * direction, since the cost of a missing suggestion is that you scroll, and the
 * cost of a wrong one is a tiramisu proposed for Tuesday night.
 */
export function isSuggestable(kind: RecipeKind): boolean {
  return kind === "DINNER";
}
