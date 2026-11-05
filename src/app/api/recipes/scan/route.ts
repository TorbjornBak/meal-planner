import { NextResponse } from "next/server";
import sharp from "sharp";
import { prisma } from "@/lib/prisma";
import { currentHouseholdContext } from "@/lib/currentUser";
import { scanRecipePage } from "@/lib/recipeOcr";
import { withImportRouteSecurity } from "@/lib/importRouteSecurity";
import { readRecipePhotoForm } from "@/lib/readRecipePhotoForm";
import { parseRecipeScan } from "@/lib/parseRecipeScan";

export const maxDuration = 300;
const MAX_BYTES = 10 * 1024 * 1024;

export async function POST(req: Request) {
  return withImportRouteSecurity(req, () => scanRecipe(req));
}

async function scanRecipe(req: Request) {
  const context = await currentHouseholdContext();
  if (!context) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const upload = await readRecipePhotoForm(req);
  if (!upload.ok) return NextResponse.json({ error: upload.error }, { status: upload.status });
  const { form } = upload;
  const files = form.getAll("photos");
  if (!files.length || files.length > 6 || files.some(f => !(f instanceof File) || !f.size || !f.type.startsWith("image/")))
    return NextResponse.json({ error: "Choose 1–6 recipe photos." }, { status: 400 });
  const photos = files as File[];
  if (photos.reduce((sum, f) => sum + f.size, 0) > MAX_BYTES)
    return NextResponse.json({ error: "Photos must total less than 10 MB." }, { status: 413 });
  const pages = [];
  try {
    for (const photo of photos) {
      // Decode and orient once; keep a readable, browser-compatible original page.
      const bytes = await sharp(Buffer.from(await photo.arrayBuffer()), { limitInputPixels: 40_000_000 })
        .rotate().resize({ width: 2400, withoutEnlargement: true }).jpeg({ quality: 90 }).toBuffer();
      const scan = await scanRecipePage(bytes);
      pages.push({ photo: new Uint8Array(bytes), mime: "image/jpeg", transcript: scan.text, position: pages.length });
    }
  } catch (error) {
    console.error("Recipe scan failed", error);
    return NextResponse.json({ error: "Could not read the photos. Try clear JPG or PNG photos with the page flat and well lit." }, { status: 422 });
  }
  const text = pages.map(p => p.transcript).join("\n\n");
  if (!text.trim()) return NextResponse.json({ error: "No text found. Try a clearer photo." }, { status: 422 });
  const draft = parseRecipeScan(text);
  const recipe = await prisma.recipe.create({
    data: {
      householdId: context.household.id,
      name: draft.name, statedServings: draft.statedServings,
      // Keep the transcript available when the layout has no recognisable method heading.
      instructions: draft.instructions ?? text,
      tags: ["manually added"],
      sourcePages: { create: pages },
      ingredients: { create: draft.ingredients.map((line, position) => ({ ...line, position })) },
    },
    select: { id: true },
  });
  return NextResponse.json(recipe, { status: 201 });
}
