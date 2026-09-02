import { extractRecipeImageUrl } from "./html.ts";
import { fetchPageHtml } from "./fetchPage.ts";
import { fetchImage, resolvePublicUrl, type FetchedImage } from "./image.ts";

interface ImageSourceDependencies {
  resolvePublicUrl: (raw: string, pageUrl?: string | null) => Promise<string | null>;
  fetchPageHtml: typeof fetchPageHtml;
  fetchImage: (url: string) => Promise<FetchedImage | null>;
}

const defaultDependencies: ImageSourceDependencies = {
  resolvePublicUrl,
  fetchPageHtml,
  fetchImage,
};

/** Find and download the photo a stored recipe's source page advertises. */
export async function fetchRecipeImageFromSource(
  sourceHtml: string | null,
  source: string | null,
  dependencies: ImageSourceDependencies = defaultDependencies,
): Promise<(FetchedImage & { imageUrl: string }) | null> {
  const pageUrl = source ? await dependencies.resolvePublicUrl(source) : null;
  let imageBaseUrl = pageUrl;
  let html = sourceHtml;

  if (!html && pageUrl) {
    const page = await dependencies.fetchPageHtml(pageUrl);
    html = page?.html ?? null;
    // Relative image metadata belongs to the terminal page, not necessarily
    // the URL stored before its redirect chain.
    imageBaseUrl = page?.finalUrl ?? pageUrl;
  }
  if (!html) return null;

  const raw = extractRecipeImageUrl(html);
  const imageUrl = raw
    ? await dependencies.resolvePublicUrl(raw, imageBaseUrl)
    : null;
  if (!imageUrl) return null;

  const image = await dependencies.fetchImage(imageUrl);
  return image ? { ...image, imageUrl } : null;
}
