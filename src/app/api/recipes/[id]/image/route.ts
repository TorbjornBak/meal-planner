import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { extractRecipeImageUrl } from "@/lib/html";
import { fetchImage, normalizeMime, resolvePublicUrl } from "@/lib/image";
import { MAX_IMAGE_BYTES } from "@/lib/recipeImage";

// The recipe photo. Stored in the database like receipt photos (§7) so the app
// stays self-contained: no image host to depend on, nothing to back up
// separately, and it renders offline once the service worker has seen it.

// GET /api/recipes/[id]/image — the photo itself.
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const recipe = await prisma.recipe.findUnique({
    where: { id },
    select: { image: true, imageMime: true, imageUrl: true },
  });

  if (recipe?.image && recipe.imageMime) {
    return new NextResponse(new Uint8Array(recipe.image), {
      headers: {
        "content-type": recipe.imageMime,
        // Immutable in practice: replacing the photo is an explicit edit, and
        // the page busts this with a ?v= stamp when that happens.
        "cache-control": "private, max-age=604800",
      },
    });
  }

  // We know where the photo lives but hold no bytes — the download failed at
  // capture time, or the recipe predates image support. Hotlink as a fallback.
  if (recipe?.imageUrl) {
    return NextResponse.redirect(recipe.imageUrl, 302);
  }

  return NextResponse.json({ error: "no image" }, { status: 404 });
}

/**
 * POST /api/recipes/[id]/image — set the photo, two ways:
 *
 *   - an `image/*` body: a file picked on the device;
 *   - a JSON body: pull it from the recipe's source page. We look in the HTML
 *     captured with the recipe first, and only re-fetch the page when we
 *     don't have it (a hand-pasted recipe with a source link).
 */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const recipe = await prisma.recipe.findUnique({
    where: { id },
    select: { source: true, sourceHtml: true },
  });
  if (!recipe) return NextResponse.json({ error: "not found" }, { status: 404 });

  const contentType = req.headers.get("content-type");
  const uploadMime = normalizeMime(contentType);

  let bytes: Buffer;
  let mime: string;
  let imageUrl: string | null = null;

  if (uploadMime) {
    bytes = Buffer.from(await req.arrayBuffer());
    mime = uploadMime;
    if (bytes.byteLength === 0) {
      return NextResponse.json({ error: "empty upload" }, { status: 400 });
    }
    if (bytes.byteLength > MAX_IMAGE_BYTES) {
      return NextResponse.json({ error: "image too large" }, { status: 413 });
    }
  } else if (contentType?.startsWith("image/")) {
    return NextResponse.json(
      { error: "unsupported image type" },
      { status: 415 },
    );
  } else {
    const found = await imageFromSource(recipe.sourceHtml, recipe.source);
    if (!found) {
      return NextResponse.json(
        { error: "no image found on the source page" },
        { status: 422 },
      );
    }
    ({ bytes, mime, imageUrl } = found);
  }

  await prisma.recipe.update({
    where: { id },
    // Prisma's Bytes field wants a plain Uint8Array; Buffer's ArrayBufferLike
    // backing store doesn't satisfy it under the current lib typings.
    data: { image: new Uint8Array(bytes), imageMime: mime, imageUrl },
  });

  return NextResponse.json({ ok: true, imageUrl });
}

// DELETE /api/recipes/[id]/image — drop the photo entirely, source URL included,
// so a bad auto-captured picture doesn't come back as a hotlinked fallback.
export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  await prisma.recipe.update({
    where: { id },
    data: { image: null, imageMime: null, imageUrl: null },
  });
  return NextResponse.json({ ok: true });
}

/** Find and download the photo the recipe's source page advertises. */
async function imageFromSource(
  sourceHtml: string | null,
  source: string | null,
): Promise<{ bytes: Buffer; mime: string; imageUrl: string } | null> {
  const pageUrl = source ? resolvePublicUrl(source) : null;

  let html = sourceHtml;
  if (!html && pageUrl) {
    // The one case where we fetch a recipe page ourselves rather than having
    // your browser hand it to us (§1). It only happens when you ask for it,
    // on a recipe you already saved with a link.
    html = await fetchHtml(pageUrl);
  }
  if (!html) return null;

  const raw = extractRecipeImageUrl(html);
  const imageUrl = raw ? resolvePublicUrl(raw, pageUrl) : null;
  if (!imageUrl) return null;

  const image = await fetchImage(imageUrl);
  return image ? { ...image, imageUrl } : null;
}

async function fetchHtml(url: string): Promise<string | null> {
  try {
    const res = await fetch(url, {
      redirect: "follow",
      signal: AbortSignal.timeout(10_000),
      headers: {
        "user-agent": "MealPlanner/1.0 (household recipe app)",
        accept: "text/html",
      },
    });
    if (!res.ok) return null;
    if (!/text\/html/i.test(res.headers.get("content-type") ?? "")) return null;
    return await res.text();
  } catch {
    return null;
  }
}
