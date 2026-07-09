import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";

// Rename, favorite, and delete for a single recipe (§2).

const PatchInput = z.object({
  name: z.string().min(1).optional(),
  isFavorite: z.boolean().optional(),
  tags: z.array(z.string()).optional(),
});

// PATCH /api/recipes/[id] — rename / toggle favorite / edit tags.
export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const parsed = PatchInput.safeParse(await req.json());
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }
  const recipe = await prisma.recipe.update({ where: { id }, data: parsed.data });
  return NextResponse.json(recipe);
}

// DELETE /api/recipes/[id] — remove from the library.
export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  await prisma.recipe.delete({ where: { id } });
  return NextResponse.json({ ok: true });
}
