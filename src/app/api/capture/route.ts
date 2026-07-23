import { NextResponse } from "next/server";
import { isValidCaptureToken } from "@/lib/auth";
import { createRecipeFromHtml } from "@/lib/importRecipe";

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

  const recipe = await createRecipeFromHtml(body.html, body.url ?? null);

  return NextResponse.json({ id: recipe.id, name: recipe.name }, { headers: CORS });
}
