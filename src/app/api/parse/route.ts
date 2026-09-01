import { NextResponse } from "next/server";
import { parseRecipeText } from "@/lib/parse";

// POST /api/parse — { text } → structured recipe draft (§1). Deterministic, no
// LLM. The response is a DRAFT for the mandatory review-and-edit step; nothing
// is saved here.
//
// No cap of its own on `text`: this is a session-authenticated, same-origin
// paste of a recipe somebody is about to review by hand, not an untrusted
// blob, and next.config.mjs's `middlewareClientMaxBodySize` (11 MB) already
// bounds the request before this handler runs. `parseRecipeText`'s patterns
// are plain alternations and bounded quantifiers with no nested repetition,
// so there's no catastrophic-backtracking blowup hiding in a pathological
// paste — worth stating since that's what makes skipping a narrower cap here
// a decision rather than an oversight.
export async function POST(req: Request) {
  const { text } = await req.json().catch(() => ({ text: "" }));
  if (!text || typeof text !== "string" || !text.trim()) {
    return NextResponse.json({ error: "text is required" }, { status: 400 });
  }

  const draft = parseRecipeText(text);
  return NextResponse.json(draft);
}
