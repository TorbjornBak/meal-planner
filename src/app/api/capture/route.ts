import { NextResponse } from "next/server";
import { isValidCaptureToken } from "@/lib/auth";
import { createRecipeFromHtml } from "@/lib/importRecipe";
import { MAX_PAGE_BYTES } from "@/lib/fetchPage";

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
  // The captured HTML is the same kind of content the paste-a-URL import
  // fetches itself (`fetchPage.ts`), just arriving from the browser instead
  // of from us — so it gets the same cap. Checked against Content-Length
  // first so an honestly-labelled oversized capture doesn't cost a buffered
  // read; re-checked against the actual body next, since this endpoint is
  // cross-origin and reachable by anything holding the household's capture
  // token, not just our own bookmarklet, and Content-Length is exactly the
  // kind of header a caller like that can simply not send or misreport.
  const declared = Number(req.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_PAGE_BYTES) {
    return NextResponse.json({ error: "payload too large" }, { status: 413, headers: CORS });
  }

  const raw = await req.text();
  if (raw.length > MAX_PAGE_BYTES) {
    return NextResponse.json({ error: "payload too large" }, { status: 413, headers: CORS });
  }

  let body: { householdId?: string; token?: string; url?: string; html?: string };
  try {
    body = JSON.parse(raw);
  } catch {
    return NextResponse.json({ error: "bad body" }, { status: 400, headers: CORS });
  }

  if (!(await isValidCaptureToken(body.householdId, body.token))) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401, headers: CORS });
  }
  if (!body.html || typeof body.html !== "string") {
    return NextResponse.json({ error: "html required" }, { status: 400, headers: CORS });
  }

  const recipe = await createRecipeFromHtml(
    body.householdId!,
    body.html,
    body.url ?? null,
  );

  return NextResponse.json({ id: recipe.id, name: recipe.name }, { headers: CORS });
}
