import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { isValidCaptureToken } from "@/lib/auth";
import { extractRecipeImageUrl, parseRecipeHtml } from "@/lib/html";
import { fetchImage, resolvePublicUrl } from "@/lib/image";

// POST /api/capture — bookmarklet capture (§1). The browser (where you're
// viewing the page as a normal reader) sends { token, url, html }; we parse it
// into a recipe and save it for review via the edit page.
//
// Authenticated by the household capture token, not the session cookie, because
// the request is cross-origin from the recipe site. The bookmarklet sends
// Content-Type: text/plain to avoid a CORS preflight.

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

export function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS });
}

export async function POST(req: Request) {
  let body: { token?: string; url?: string; html?: string };
  try {
    body = JSON.parse(await req.text());
  } catch {
    return NextResponse.json({ error: "bad body" }, { status: 400, headers: CORS });
  }

  if (!(await isValidCaptureToken(body.token))) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401, headers: CORS });
  }
  if (!body.html || typeof body.html !== "string") {
    return NextResponse.json({ error: "html required" }, { status: 400, headers: CORS });
  }

  const draft = parseRecipeHtml(body.html);

  // The page's own photo, downloaded so the recipe carries its picture without
  // hotlinking. Best-effort: a missing or unreachable image never fails the
  // capture — you can always add one by hand on the edit page.
  const rawImageUrl = extractRecipeImageUrl(body.html);
  const imageUrl = rawImageUrl ? resolvePublicUrl(rawImageUrl, body.url) : null;
  const image = imageUrl ? await fetchImage(imageUrl) : null;

  const recipe = await prisma.recipe.create({
    data: {
      name: draft.name,
      source: body.url ?? draft.source ?? null,
      instructions: draft.instructions ?? null,
      sourceHtml: body.html,
      statedServings: draft.statedServings,
      imageUrl,
      // Prisma's Bytes field wants a plain Uint8Array, not a Buffer.
      image: image ? new Uint8Array(image.bytes) : null,
      imageMime: image?.mime ?? null,
      ingredients: {
        create: draft.ingredients.map((ing, i) => ({
          name: ing.name,
          quantity: ing.quantity,
          unit: ing.unit,
          position: i,
        })),
      },
    },
  });

  return NextResponse.json({ id: recipe.id, name: recipe.name }, { headers: CORS });
}
