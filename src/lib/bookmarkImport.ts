/**
 * Read the recipe page handed to `/recipes/new` by the bookmarklet.
 *
 * Keeping this at the query-string boundary means opening the import page by
 * hand is harmless: only an absolute HTTP(S) page can start a fetch.
 */
export function recipeUrlFromBookmarkSearch(search: string): string | null {
  const raw = new URLSearchParams(search).get("url")?.trim();
  if (!raw) return null;

  try {
    const url = new URL(raw);
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}

/** A bookmarklet that hands the current tab to MealPlanner's own import page. */
export function bookmarkletForOrigin(origin: string): string {
  const appOrigin = new URL(origin).origin;
  return `javascript:(function(){var p=location.href,b=${JSON.stringify(
    appOrigin,
  )};location.href=b+'/recipes/new?url='+encodeURIComponent(p)})()`;
}
