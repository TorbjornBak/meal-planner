import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { OMIT_RECIPE_BLOBS } from "@/lib/recipeImage";
import { RECIPE_KINDS } from "@/lib/recipeKind";
import { RECIPE_CATEGORIES } from "@/lib/recipeCategory";

// Recipe library CRUD (§2).

const RecipeInput = z.object({
  name: z.string().min(1),
  // Dinner or drink (§2c). Optional so every existing caller — the paste-text
  // review step, the bookmarklet, the transfer import — keeps working and gets
  // the column's own default.
  kind: z.enum(RECIPE_KINDS).optional(),
  // What it's made of (§2d). Nullable as well as optional: "nobody has said"
  // is a real answer here and the one the review step offers by default — the
  // parser can't tell a vegetarian lasagne from a meat one, and guessing would
  // be the app inventing a dietary claim.
  category: z.enum(RECIPE_CATEGORIES).nullable().optional(),
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

/**
 * What the library list adds on top of the stored recipe row.
 *
 * The whole-dish time (`totalTimeMinutes` / `totalTimeIsEstimate`) needs no
 * mention here — `omit` drops only the blobs, so every other scalar on Recipe
 * already rides along, and the library renders those two straight from the row.
 */
interface RecipeListExtras {
  /**
   * The Monday of the most recent week this recipe was on the plan, or null if
   * it has never been on one. A week, not a night: the plan is keyed by week
   * (§3), and "what haven't we made in ages" is asked in weeks.
   *
   * Weeks *ahead* of today count too. A dish already booked for next week isn't
   * stale, and calling it "never cooked" would invite planning it twice; the
   * library labels a future week as planned rather than cooked.
   */
  lastCookedOn: Date | null;
}

// GET /api/recipes — list the library (favourites first, then by name), each
// row carrying the week it was last cooked (§2, §3).
export async function GET() {
  // Two queries for the whole library, and two however many recipes there are
  // — never one per recipe.
  //
  // The shape you'd reach for first, `dinnerSlot.groupBy(['recipeId'], { _max:
  // ... })`, can't express this: the date lives on WeekPlan, and `_max` only
  // reaches scalars of the model being grouped. Nothing on DinnerSlot itself
  // orders in time either — a cuid is not a clock — so the join has to come
  // along, which means folding the rows ourselves.
  //
  // So: every slot, two columns wide, reduced to a max per recipe below. The
  // table holds one row per dinner ever planned — seven a week for one
  // household — so it is a few thousand narrow rows after years of use, which
  // is cheaper to ship and fold than the round trips a per-recipe query would
  // cost. Both queries go out at once; neither depends on the other.
  const [recipes, slots] = await Promise.all([
    prisma.recipe.findMany({
      orderBy: [{ isFavorite: "desc" }, { name: "asc" }],
      omit: OMIT_RECIPE_BLOBS,
      include: { ingredients: { orderBy: { position: "asc" } } },
    }),
    prisma.dinnerSlot.findMany({
      select: { recipeId: true, weekPlan: { select: { weekStart: true } } },
    }),
  ]);

  const lastCookedOn = new Map<string, Date>();
  for (const slot of slots) {
    const week = slot.weekPlan.weekStart;
    const latest = lastCookedOn.get(slot.recipeId);
    if (!latest || week > latest) lastCookedOn.set(slot.recipeId, week);
  }

  const rows = recipes.map(
    (recipe): typeof recipe & RecipeListExtras => ({
      ...recipe,
      lastCookedOn: lastCookedOn.get(recipe.id) ?? null,
    }),
  );

  return NextResponse.json(rows);
}

// POST /api/recipes — save a reviewed-and-edited recipe (§1, §2).
export async function POST(req: Request) {
  const parsed = RecipeInput.safeParse(await req.json());
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }
  const { name, kind, category, source, instructions, statedServings, tags, ingredients } =
    parsed.data;

  const recipe = await prisma.recipe.create({
    data: {
      name,
      ...(kind ? { kind } : {}),
      category: category ?? null,
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
