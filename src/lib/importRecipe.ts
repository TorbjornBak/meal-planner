import { prisma } from "./prisma";
import { extractRecipeImageUrl, parseRecipeHtml } from "./html";
import { fetchImage, resolvePublicUrl } from "./image";
import type { ParsedRecipe } from "./parse";

/**
 * Turn a page's HTML into a saved recipe draft (§1). Shared by the bookmarklet
 * capture (browser sends the HTML) and the paste-a-URL import (server fetches
 * it): both parse the same HTML with the same extractor and download the page's
 * own photo once, storing the bytes rather than hotlinking (§2b).
 *
 * The saved recipe is a DRAFT — the mandatory review-and-edit step happens on
 * the edit page, exactly as it does for a captured recipe.
 *
 * Pass a pre-parsed `draft` to avoid re-parsing when the caller already has one
 * (the import route parses first to confirm there's a recipe before saving).
 */
export async function createRecipeFromHtml(
  html: string,
  pageUrl?: string | null,
  draft?: ParsedRecipe,
) {
  const parsed = draft ?? parseRecipeHtml(html);

  // The page's own photo, downloaded so the recipe carries its picture without
  // hotlinking. Best-effort: a missing or unreachable image never fails the
  // save — you can always add one by hand on the edit page.
  const rawImageUrl = extractRecipeImageUrl(html);
  const imageUrl = rawImageUrl ? resolvePublicUrl(rawImageUrl, pageUrl) : null;
  const image = imageUrl ? await fetchImage(imageUrl) : null;

  return prisma.recipe.create({
    data: {
      name: parsed.name,
      source: pageUrl ?? parsed.source ?? null,
      instructions: parsed.instructions ?? null,
      sourceHtml: html,
      statedServings: parsed.statedServings,
      imageUrl,
      // Prisma's Bytes field wants a plain Uint8Array, not a Buffer.
      image: image ? new Uint8Array(image.bytes) : null,
      imageMime: image?.mime ?? null,
      ingredients: {
        create: parsed.ingredients.map((ing, i) => ({
          name: ing.name,
          quantity: ing.quantity,
          unit: ing.unit,
          position: i,
        })),
      },
    },
  });
}
