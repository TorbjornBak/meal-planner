import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { OMIT_RECIPE_BLOBS } from "@/lib/recipeImage";

// Recipe library CRUD (§2).

const RecipeInput = z.object({
  name: z.string().min(1),
  source: z.string().optional().nullable(),
  instructions: z.string().optional().nullable(),
  statedServings: z.number().int().positive(),
  tags: z.array(z.string()).optional(),
  ingredients: z.array(
    z.object({
      name: z.string().min(1),
      quantity: z.number().nullable(),
      unit: z.string().nullable(),
    }),
  ),
});

// GET /api/recipes — list the library (newest first).
export async function GET() {
  const recipes = await prisma.recipe.findMany({
    orderBy: [{ isFavorite: "desc" }, { name: "asc" }],
    omit: OMIT_RECIPE_BLOBS,
    include: { ingredients: { orderBy: { position: "asc" } } },
  });
  return NextResponse.json(recipes);
}

// POST /api/recipes — save a reviewed-and-edited recipe (§1, §2).
export async function POST(req: Request) {
  const parsed = RecipeInput.safeParse(await req.json());
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }
  const { name, source, instructions, statedServings, tags, ingredients } =
    parsed.data;

  const recipe = await prisma.recipe.create({
    data: {
      name,
      source: source ?? null,
      instructions: instructions ?? null,
      statedServings,
      tags: tags ?? [],
      ingredients: {
        create: ingredients.map((ing, i) => ({
          name: ing.name,
          quantity: ing.quantity,
          unit: ing.unit,
          position: i,
        })),
      },
    },
    omit: OMIT_RECIPE_BLOBS,
    include: { ingredients: true },
  });

  return NextResponse.json(recipe, { status: 201 });
}
