import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { OMIT_RECIPE_BLOBS } from "@/lib/recipeImage";
import { RECIPE_KINDS } from "@/lib/recipeKind";
import { RECIPE_CATEGORIES } from "@/lib/recipeCategory";

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
    include: {
      ingredients: { orderBy: { position: "asc" } },
      // How many nights it is currently on, so the editor's delete step can
      // say what deleting costs: the slots go with it (cascade), and a recipe
      // that is on this week's plan is not the same thing to delete as one
      // nobody has cooked yet.
      _count: { select: { dinnerSlots: true } },
    },
  });
  if (!recipe) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  return NextResponse.json(recipe);
}

const PatchInput = z.object({
  name: z.string().min(1).optional(),
  // Moving a recipe between the library's two sections (§2c) is an ordinary
  // edit — a coffee filed as dinner is a typo, not a reason to retype it.
  kind: z.enum(RECIPE_KINDS).optional(),
  // What it's made of (§2d). Nullable so a category can be *taken back* and
  // not merely changed — mislabelling a dish vegetarian is the one mistake
  // here worth being able to undo to silence rather than to another claim.
  category: z.enum(RECIPE_CATEGORIES).nullable().optional(),
  source: z.string().nullable().optional(),
  instructions: z.string().nullable().optional(),
  statedServings: z.number().int().positive().optional(),
  // How long it takes (§2). Nullable so a wrong parse can be cleared rather
  // than only overwritten, and `totalTimeIsEstimate` rides along with it: the
  // edit page clears the flag when a human types a time and sets it when they
  // ask for the from-the-method sum, so the two always move together.
  totalTimeMinutes: z.number().int().positive().nullable().optional(),
  totalTimeIsEstimate: z.boolean().optional(),
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
