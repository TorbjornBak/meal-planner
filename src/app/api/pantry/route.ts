import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { ingredientKey } from "@/lib/keys";

// Pantry list (§5) — the household's curated "things we always have". Matched
// by normalized name against shopping-list items.

// GET /api/pantry — list pantry items.
export async function GET() {
  const items = await prisma.pantryItem.findMany({ orderBy: { name: "asc" } });
  return NextResponse.json(items);
}

const PostInput = z.object({ name: z.string().min(1) });

// POST /api/pantry — add a pantry item (idempotent by normalized key).
export async function POST(req: Request) {
  const parsed = PostInput.safeParse(await req.json());
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }
  const name = parsed.data.name.trim();
  const item = await prisma.pantryItem.upsert({
    where: { nameKey: ingredientKey(name) },
    update: { name },
    create: { name, nameKey: ingredientKey(name) },
  });
  return NextResponse.json(item, { status: 201 });
}

// DELETE /api/pantry?id=... — remove a pantry item.
export async function DELETE(req: Request) {
  const id = new URL(req.url).searchParams.get("id");
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });
  await prisma.pantryItem.delete({ where: { id } });
  return NextResponse.json({ ok: true });
}
