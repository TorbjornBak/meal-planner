import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { OMIT_RECIPE_BLOBS } from "@/lib/recipeImage";

// Rename, favorite, and delete for a single recipe (§2).

// GET /api/recipes/[id] — a single recipe with its ingredients (for editing).
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const recipe = await prisma.recipe.findUnique({
    where: { id },
    omit: OMIT_RECIPE_BLOBS,
    include: { ingredients: { orderBy: { position: "asc" } } },
  });
  if (!recipe) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  return NextResponse.json(recipe);
}

const PatchInput = z.object({
  name: z.string().min(1).optional(),
  source: z.string().nullable().optional(),
  instructions: z.string().nullable().optional(),
  statedServings: z.number().int().positive().optional(),
  isFavorite: z.boolean().optional(),
  tags: z.array(z.string()).optional(),
  // When present, fully replaces the recipe's ingredient lines.
  ingredients: z
    .array(
      z.object({
        name: z.string().min(1),
        quantity: z.number().nullable(),
        unit: z.string().nullable(),
      }),
    )
    .optional(),
});

// PATCH /api/recipes/[id] — quick actions (rename / favorite) or a full edit
// (fields + ingredient replacement).
export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const parsed = PatchInput.safeParse(await req.json());
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }
  const { ingredients, ...fields } = parsed.data;

  const recipe = await prisma.$transaction(async (tx) => {
    await tx.recipe.update({ where: { id }, data: fields });
    if (ingredients) {
      await tx.ingredientLine.deleteMany({ where: { recipeId: id } });
      await tx.ingredientLine.createMany({
        data: ingredients.map((ing, i) => ({
          recipeId: id,
          name: ing.name,
          quantity: ing.quantity,
          unit: ing.unit,
          position: i,
        })),
      });
    }
    return tx.recipe.findUnique({
      where: { id },
      omit: OMIT_RECIPE_BLOBS,
      include: { ingredients: { orderBy: { position: "asc" } } },
    });
  });

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
