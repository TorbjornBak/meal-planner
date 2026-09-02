import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { normalizeMime, resolvePublicUrl } from "@/lib/image";
import { MAX_IMAGE_BYTES } from "@/lib/recipeImage";
import { fetchRecipeImageFromSource } from "@/lib/recipeImageSource";
import { currentHouseholdContext } from "@/lib/currentUser";

// The recipe photo. Stored in the database like receipt photos (§7) so the app
// stays self-contained: no image host to depend on, nothing to back up
// separately, and it renders offline once the service worker has seen it.

// GET /api/recipes/[id]/image — the photo itself.
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const context = await currentHouseholdContext();
  if (!context) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { id } = await params;
  const recipe = await prisma.recipe.findFirst({
    where: { id, householdId: context.household.id },
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
  // capture time, or the recipe predates image support. Hotlink as a
  // fallback, but re-run the same private-network guard every other outbound
  // URL in this app gets immediately before using it, rather than trusting a
  // check done once at write time. `imageUrl` was already run through
  // `resolvePublicUrl` by both writers (`imageFromSource` below and
  // `createRecipeFromHtml`), but DNS is not a fact fixed at the moment it was
  // saved — a host that resolved to a public address then can resolve
  // somewhere this server refuses to fetch (a private network, its
  // loopback) by the time somebody opens the recipe, same as the redirect
  // hop this module already re-checks in `guardedFetch`. A stale/rebound
  // target is quietly treated as "no image" rather than followed.
  if (recipe?.imageUrl) {
    const target = await resolvePublicUrl(recipe.imageUrl);
    if (target) return NextResponse.redirect(target, 302);
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
  const context = await currentHouseholdContext();
  if (!context) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { id } = await params;
  const recipe = await prisma.recipe.findFirst({
    where: { id, householdId: context.household.id },
    select: { source: true, sourceHtml: true },
  });
  if (!recipe) return NextResponse.json({ error: "not found" }, { status: 404 });

  const contentType = req.headers.get("content-type");
  const uploadMime = normalizeMime(contentType);

  let bytes: Buffer;
  let mime: string;
  let imageUrl: string | null = null;

  if (uploadMime) {
    // Fail on the client's own Content-Length before reading the body, so an
    // honestly-labelled oversized upload doesn't cost us a buffered copy of
    // it first. Not a substitute for the byte-length check below — a client
    // can always lie about, or omit, this header — just cheaper for the
    // common case of a browser upload that reports its size correctly.
    const declared = Number(req.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > MAX_IMAGE_BYTES) {
      return NextResponse.json({ error: "image too large" }, { status: 413 });
    }

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
    const found = await fetchRecipeImageFromSource(recipe.sourceHtml, recipe.source);
    if (!found) {
      return NextResponse.json(
        { error: "no image found on the source page" },
        { status: 422 },
      );
    }
    ({ bytes, mime, imageUrl } = found);
  }

  await prisma.recipe.update({
    where: { id, householdId: context.household.id },
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
  const context = await currentHouseholdContext();
  if (!context) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { id } = await params;
  const recipe = await prisma.recipe.findFirst({
    where: { id, householdId: context.household.id },
    select: { id: true },
  });
  if (!recipe) return NextResponse.json({ error: "not found" }, { status: 404 });

  await prisma.recipe.update({
    where: { id, householdId: context.household.id },
    data: { image: null, imageMime: null, imageUrl: null },
  });
  return NextResponse.json({ ok: true });
}
