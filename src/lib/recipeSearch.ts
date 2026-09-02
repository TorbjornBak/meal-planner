/**
 * Searching the recipe library by name and ingredient (§2).
 *
 * Two screens need the same answer: the library's ingredient chips, and the
 * picker that replaced the seven per-night <select>s on the plan page (§3).
 * They used to disagree, so this lives in one place.
 *
 * Deterministic and in-process like everything else (§12): a fold and a
 * substring test, no index, no service. The whole library is a few hundred
 * rows and `GET /api/recipes` already ships every recipe's ingredients, so the
 * search runs in the browser — no request per keystroke, and it still works
 * offline when the app is temporarily unreachable (§10).
 */

export interface SearchableRecipe {
  name: string;
  ingredients: { name: string }[];
}

export interface RecipeMatch<R> {
  recipe: R;
  /**
   * The ingredient names — as written — that the query matched, in the
   * recipe's own order. Lets the UI say *why* a recipe turned up, which
   * matters when the query hit nothing you can see in the title.
   * Empty when the query matched only the recipe's name, or when there is
   * no query at all.
   */
  matchedIngredients: string[];
}

/*
 * NFKD splits a letter into a base plus combining marks, which is how "purée"
 * becomes "puree" below. It does **not** touch ø or æ: those are single
 * codepoints, not an o or an a with something stuck on, so no amount of
 * normalizing decomposes them. And å *does* decompose — to a bare "a" — which
 * is the wrong answer here.
 *
 * So the three Danish letters are mapped by hand, to what someone types when
 * they can't be bothered to reach for them: rødgrød → rodgrod, blåbær →
 * blaabaer. Without this, typing "rodgrod" never finds "rødgrød", and the
 * parser this library is fed by is Danish-first. Please don't "simplify" this
 * away into a lone normalize() — it is load-bearing.
 *
 * It has to run *before* normalize(), or å is already a plain "a" by the time
 * we get here and the "aa" is unrecoverable.
 */
const DANISH_FOLD: Record<string, string> = { ø: "o", æ: "ae", å: "aa" };

/**
 * A recipe name or ingredient name reduced to something a typed query can be
 * compared against: lowercase, unaccented, single-spaced.
 *
 * Deliberately *not* `ingredientKey` from ./keys (§5). That one strips
 * punctuation and a trailing plural "s" to decide whether two ingredients are
 * the same thing for merging and diffing; equality is the whole point of it.
 * Substring search wants a lighter touch — "løg" has to keep matching inside
 * "rødløg", and nothing here may depend on a key staying stable.
 */
export function foldForSearch(s: string): string {
  return s
    .toLowerCase()
    .replace(/[øæå]/g, (c) => DANISH_FOLD[c])
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * The recipes matching `query`, in the order they were given.
 *
 * The query is split on whitespace and the terms are ANDed: every term has to
 * hit somewhere, but they may hit different places — "kylling karry" finds a
 * recipe named "Kylling i karry" and one named "Butter chicken" with curry
 * powder in it. A term hits if it is a substring of the folded recipe name or
 * of any folded ingredient name.
 *
 * A blank query returns the whole library untouched, in the caller's order
 * (favourites first, then name ascending, as `GET /api/recipes` sorts it):
 * opening the picker has to be useful before you have typed anything.
 */
export function searchRecipes<R extends SearchableRecipe>(
  recipes: readonly R[],
  query: string,
): RecipeMatch<R>[] {
  // Deduped, so "løg løg" doesn't need to hit twice for the count below.
  const terms = [...new Set(foldForSearch(query).split(" ").filter(Boolean))];

  if (terms.length === 0) {
    return recipes.map((recipe) => ({ recipe, matchedIngredients: [] }));
  }

  const matches: RecipeMatch<R>[] = [];
  for (const recipe of recipes) {
    // Which of the terms found a home anywhere in this recipe. AND is then
    // just "all of them did", counted at the end.
    const hits = new Set<string>();

    const name = foldForSearch(recipe.name);
    for (const term of terms) if (name.includes(term)) hits.add(term);

    const matchedIngredients: string[] = [];
    const seen = new Set<string>();
    for (const ingredient of recipe.ingredients) {
      const folded = foldForSearch(ingredient.name);
      let matchedHere = false;
      for (const term of terms) {
        if (folded.includes(term)) {
          hits.add(term);
          matchedHere = true;
        }
      }
      // Deduped by the folded name: a recipe that lists "løg" twice should
      // only explain itself once.
      if (matchedHere && !seen.has(folded)) {
        seen.add(folded);
        matchedIngredients.push(ingredient.name);
      }
    }

    if (hits.size === terms.length) matches.push({ recipe, matchedIngredients });
  }
  return matches;
}
