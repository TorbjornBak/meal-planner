import { NextResponse } from "next/server";
import { parseRecipeText } from "@/lib/parse";

// POST /api/parse — { text } → structured recipe draft (§1). Deterministic, no
// LLM. The response is a DRAFT for the mandatory review-and-edit step; nothing
// is saved here.
export async function POST(req: Request) {
  const { text } = await req.json().catch(() => ({ text: "" }));
  if (!text || typeof text !== "string" || !text.trim()) {
    return NextResponse.json({ error: "text is required" }, { status: 400 });
  }

  const draft = parseRecipeText(text);
  return NextResponse.json(draft);
}
