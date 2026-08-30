/**
 * Picking dinners out of the library at random (§2e).
 *
 * The library is a first-class asset (§2) that grows in one direction: things
 * go in, and the same eight come back out, because choosing is work and the
 * screen that shows you everything is no help with it. The staleness sort
 * (§2) attacks this from one side — "what haven't we made in ages" — but that
 * is a question you have to think to ask. This is the other side: the
 * dashboard offers three, unasked, and you either take one or press again.
 *
 * Randomness rather than a ranking, deliberately. A recommender would need to
 * decide what makes a dinner good tonight, which is a thing this app cannot
 * know and would need an LLM to fake (§12 — everything here is deterministic
 * and in-process). Three at random out of a library you chose every item of is
 * already a good enough answer, and it is one you can explain, which a score
 * out of your own cooking history is not.
 *
 * Pure and dependency-free: the randomness is a parameter, not `Math.random`
 * reached for in the middle of the logic, so every rule below is testable and
 * `npm test` runs this straight through Node.
 */

import { isSuggestable, type RecipeKind } from "./recipeKind.ts";
import { matchesCategoryFilter, type CategoryFilter, type RecipeCategory } from "./recipeCategory.ts";

/**
 * Three. Enough that one of them lands, few enough to read without deciding to
 * read them — the card is glanced at on the way past, not studied.
 */
export const DEFAULT_SUGGESTION_COUNT = 3;

/** What the picker needs to know about a recipe. Everything else is the UI's. */
export interface SuggestibleRecipe {
  id: string;
  /** What it is (§2c) — only a dinner can be suggested. */
  kind: RecipeKind;
  /** What it's made of (§2d), or null if nobody has said. */
  category: RecipeCategory | null;
}

export interface SuggestionOptions {
  /** How many to hand back. Fewer come back if the library can't fill it. */
  count?: number;
  /** Narrow to a category (§2d). Defaults to no narrowing. */
  filter?: CategoryFilter;
  /** Recipe ids already on the week being planned — see `eligibleForSuggestion`. */
  planned?: Iterable<string>;
  /** Recipe ids currently on screen — see `suggestRecipes`. */
  avoid?: Iterable<string>;
  /** Injected so the tests are not a coin flip. */
  random?: () => number;
}

/**
 * The recipes it would make sense to offer.
 *
 * Two exclusions, both of them the difference between a suggestion and noise:
 *
 * **Everything that isn't dinner is out.** The question is what the meal is, so
 * a drink and a dessert are obviously not answers — and neither is a side,
 * though that one can go on a night. A card offering two stews and a green
 * salad has answered a question nobody asked; you reach for a side once you
 * know what it is going next to. `isSuggestable` is asked rather than
 * `kind === "DINNER"` compared, so the day a fifth kind arrives this screen
 * inherits whatever §2c decides about it.
 *
 * **This week's dinners are out.** A recipe you have already committed to
 * Thursday is the one thing on the shelf that is definitely not an answer to
 * "what else?" — offering it back reads as the app having lost track of the
 * plan, and taking the offer would put it on the week twice.
 *
 * Order is preserved from the caller, which matters more than it looks: the
 * library arrives favourites-first (`GET /api/recipes`), and `pickRandom`
 * below is order-independent, so nothing here quietly becomes a ranking.
 */
export function eligibleForSuggestion<R extends SuggestibleRecipe>(
  recipes: readonly R[],
  options: { filter?: CategoryFilter; planned?: Iterable<string> } = {},
): R[] {
  const planned = new Set(options.planned ?? []);
  const filter = options.filter ?? "ANY";
  return recipes.filter(
    (r) =>
      isSuggestable(r.kind) &&
      !planned.has(r.id) &&
      matchesCategoryFilter(r.category, filter),
  );
}

/**
 * `count` items chosen uniformly at random, without repeats, in random order.
 *
 * A partial Fisher–Yates over a copy: swap a random survivor into each of the
 * first `count` positions and stop. Uniform, one pass, and — the reason it is
 * written out rather than being `sort(() => random() - 0.5)`, which is the
 * one-liner everybody reaches for — actually correct. A comparator built on
 * randomness is not a consistent ordering, so the sort is free to produce a
 * badly skewed permutation, and does.
 *
 * Fewer than `count` come back when there isn't enough to go round, which is
 * the normal state of a library with two dinners in it, not an error.
 */
export function pickRandom<T>(
  items: readonly T[],
  count: number,
  random: () => number = Math.random,
): T[] {
  const pool = [...items];
  const take = Math.max(0, Math.min(count, pool.length));
  for (let i = 0; i < take; i++) {
    // Clamped: a random() that returns exactly 1 — which Math.random never
    // does, but an injected one might — would index off the end and put an
    // `undefined` in the results.
    const j = Math.min(pool.length - 1, i + Math.floor(random() * (pool.length - i)));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return pool.slice(0, take);
}

/**
 * What the dashboard shows: `count` eligible recipes, avoiding the ones
 * already on screen.
 *
 * `avoid` is what makes the shuffle button worth pressing. Picking uniformly
 * from the whole shelf every time means a library of five hands you two of the
 * same three back, and a button that appears not to have worked is worse than
 * no button. So the unseen ones are drawn from first, and only if they run out
 * is the rest of the pool used to top up — which is the honest behaviour when
 * the library is smaller than the card: you get everything it has, rather than
 * an empty card insisting there is nothing new.
 */
export function suggestRecipes<R extends SuggestibleRecipe>(
  recipes: readonly R[],
  options: SuggestionOptions = {},
): R[] {
  const count = options.count ?? DEFAULT_SUGGESTION_COUNT;
  const random = options.random ?? Math.random;
  const eligible = eligibleForSuggestion(recipes, options);

  const avoid = new Set(options.avoid ?? []);
  if (avoid.size === 0) return pickRandom(eligible, count, random);

  const unseen = eligible.filter((r) => !avoid.has(r.id));
  const picks = pickRandom(unseen, count, random);
  if (picks.length >= count) return picks;

  // Not enough unseen ones to fill the card. Top up from the ones we were
  // trying to avoid — shuffled too, so the repeats at least move around.
  const seen = eligible.filter((r) => avoid.has(r.id));
  return [...picks, ...pickRandom(seen, count - picks.length, random)];
}
