/**
 * Recipe photos as seen from the *outside* of the database — what JSON callers
 * and React components need to know. The server-side fetching and validation
 * lives in `image.ts`.
 */

/**
 * Cap on a stored photo. Large enough for any real recipe picture, small
 * enough that the database and its nightly backup (§11) stay sane.
 */
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

/**
 * Fields every recipe query should leave behind. `image` is megabytes of binary
 * that no JSON caller can use (it's served from /api/recipes/[id]/image), and
 * `sourceHtml` is a whole captured page kept only for re-parsing.
 *
 * `imageMime` survives: non-null means we hold real bytes, which is how the UI
 * knows a photo exists without loading it.
 */
export const OMIT_RECIPE_BLOBS = { image: true, sourceHtml: true } as const;

/** What the UI needs to decide whether — and how — to show a photo. */
export interface RecipeImageFields {
  id: string;
  imageMime?: string | null;
  imageUrl?: string | null;
}

export function hasRecipeImage(recipe: RecipeImageFields): boolean {
  return Boolean(recipe.imageMime || recipe.imageUrl);
}

/**
 * Where to point an <img>. Always our own endpoint — it serves stored bytes and
 * falls back to redirecting at the original host — so the browser and the
 * service worker see one stable URL per recipe.
 */
export function recipeImageSrc(recipe: RecipeImageFields): string | null {
  return hasRecipeImage(recipe) ? `/api/recipes/${recipe.id}/image` : null;
}
