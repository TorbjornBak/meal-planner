import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { ingredientKey } from "@/lib/keys";
import { currentHouseholdContext } from "@/lib/currentUser";

// Pantry list (§5) — the household's curated "things we always have". Matched
// by normalized name against shopping-list items.

// GET /api/pantry — list pantry items.
export async function GET() {
  const context = await currentHouseholdContext();
  if (!context) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const items = await prisma.pantryItem.findMany({
    where: { householdId: context.household.id },
    orderBy: { name: "asc" },
  });
  return NextResponse.json(items);
}

const PostInput = z.object({ name: z.string().min(1) });

// POST /api/pantry — add a pantry item (idempotent by normalized key).
export async function POST(req: Request) {
  const context = await currentHouseholdContext();
  if (!context) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const parsed = PostInput.safeParse(await req.json());
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }
  const name = parsed.data.name.trim();
  const householdId = context.household.id;
  const nameKey = ingredientKey(name);
  const item = await prisma.pantryItem.upsert({
    where: { householdId_nameKey: { householdId, nameKey } },
    update: { name },
    create: { householdId, name, nameKey },
  });
  return NextResponse.json(item, { status: 201 });
}

// DELETE /api/pantry?id=... — remove a pantry item.
export async function DELETE(req: Request) {
  const context = await currentHouseholdContext();
  if (!context) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const id = new URL(req.url).searchParams.get("id");
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });
  const deleted = await prisma.pantryItem.deleteMany({
    where: { id, householdId: context.household.id },
  });
  if (deleted.count === 0) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json({ ok: true });
}
