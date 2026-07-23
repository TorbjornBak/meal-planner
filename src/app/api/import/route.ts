import { NextResponse } from "next/server";
import { fetchPageHtml } from "@/lib/fetchPage";
import { parseRecipeHtml } from "@/lib/html";
import { createRecipeFromHtml } from "@/lib/importRecipe";

// POST /api/import — paste-a-URL import (§1, the fast path). Session-protected
// by the middleware (a normal in-app request, unlike cross-origin /api/capture).
//
// The server fetches the page and runs it through the SAME extractor the
// bookmarklet capture uses, then saves a draft for the mandatory review-and-edit
// step on the edit page. When a page can't be fetched or carries no recipe
// (bot wall, JS-only, paywall), it returns a clear message pointing at the
// bookmarklet, which always works because it's your real browser.
export async function POST(req: Request) {
  const { url } = await req.json().catch(() => ({ url: "" }));
  if (typeof url !== "string" || !/^https?:\/\/\S+/i.test(url.trim())) {
    return NextResponse.json(
      { error: "Paste a recipe page URL (starting with http:// or https://)." },
      { status: 400 },
    );
  }

  const page = await fetchPageHtml(url.trim());
  if (!page) {
    return NextResponse.json(
      {
        error:
          "Couldn't fetch that page — it may block bots or need a login. Use the bookmarklet instead.",
      },
      { status: 502 },
    );
  }

  // Confirm we actually found a recipe before saving, so a bot-challenge or
  // paywall page doesn't create an empty draft.
  const draft = parseRecipeHtml(page.html);
  if (draft.ingredients.length === 0) {
    return NextResponse.json(
      {
        error:
          "Fetched the page but found no recipe on it. Use the bookmarklet instead.",
      },
      { status: 422 },
    );
  }

  const recipe = await createRecipeFromHtml(page.html, page.finalUrl, draft);
  return NextResponse.json({ id: recipe.id, name: recipe.name }, { status: 201 });
}
