import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { OMIT_RECIPE_BLOBS } from "@/lib/recipeImage";
import { aggregateShoppingList, type SlotForList } from "@/lib/shopping";

// Shopping list generation + retrieval (§5).

// GET /api/shopping?weekPlanId=... — the current persisted list for a week.
export async function GET(req: Request) {
  const weekPlanId = new URL(req.url).searchParams.get("weekPlanId");
  if (!weekPlanId) {
    return NextResponse.json({ error: "weekPlanId required" }, { status: 400 });
  }
  const list = await prisma.shoppingList.findUnique({
    where: { weekPlanId },
    include: { items: true },
  });
  return NextResponse.json(list);
}

const PostInput = z.object({ weekPlanId: z.string().min(1) });

// POST /api/shopping — (re)generate the list for a week plan.
//
// The list is keyed by ingredient identity so it can be diffed against plan
// changes (§5): surviving items keep their checked state, new ingredients
// arrive unchecked, removed ones drop off.
export async function POST(req: Request) {
  const parsed = PostInput.safeParse(await req.json());
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }
  const { weekPlanId } = parsed.data;

  const plan = await prisma.weekPlan.findUnique({
    where: { id: weekPlanId },
    include: {
      slots: {
        include: {
          recipe: { omit: OMIT_RECIPE_BLOBS, include: { ingredients: true } },
        },
      },
    },
  });
  if (!plan) {
    return NextResponse.json({ error: "week plan not found" }, { status: 404 });
  }

  const settings = await prisma.settings.upsert({
    where: { id: 1 },
    update: {},
    create: { id: 1 },
  });
  const pantry = await prisma.pantryItem.findMany();
  const pantryKeys = new Set(pantry.map((p) => p.nameKey));

  const slots: SlotForList[] = plan.slots.map((s) => ({
    servingsOverride: s.servingsOverride,
    recipe: s.recipe
      ? {
          statedServings: s.recipe.statedServings,
          ingredients: s.recipe.ingredients.map((i) => ({
            name: i.name,
            quantity: i.quantity,
            unit: i.unit,
          })),
        }
      : null,
  }));

  const aggregated = aggregateShoppingList(slots, settings.householdSize, pantryKeys);

  // Preserve checked state for ingredients that survive the regeneration.
  const existing = await prisma.shoppingList.findUnique({
    where: { weekPlanId },
    include: { items: true },
  });
  const checkedByKey = new Map(
    (existing?.items ?? []).map((i) => [i.ingredientKey, i.checked]),
  );

  // Replace the item set atomically, carrying checked state forward.
  const list = await prisma.$transaction(async (tx) => {
    const sl = await tx.shoppingList.upsert({
      where: { weekPlanId },
      update: { generatedAt: new Date() },
      create: { weekPlanId },
    });
    await tx.shoppingListItem.deleteMany({ where: { shoppingListId: sl.id } });
    await tx.shoppingListItem.createMany({
      data: aggregated.map((a) => ({
        shoppingListId: sl.id,
        ingredientKey: a.ingredientKey,
        displayName: a.displayName,
        quantity: a.quantity,
        unit: a.unit,
        altQuantity: a.altQuantity,
        altUnit: a.altUnit,
        isPantry: a.isPantry,
        checked: checkedByKey.get(a.ingredientKey) ?? false,
      })),
    });
    return tx.shoppingList.findUnique({
      where: { id: sl.id },
      include: { items: true },
    });
  });

  return NextResponse.json(list, { status: 200 });
}
