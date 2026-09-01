import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { OMIT_RECIPE_BLOBS } from "@/lib/recipeImage";
import { mergeManualItems } from "@/lib/manualItems";
import { aggregateShoppingList, type SlotForList } from "@/lib/shopping";
import { currentHouseholdContext } from "@/lib/currentUser";

// Shopping list generation + retrieval (§5).

// GET /api/shopping?weekPlanId=... — the current persisted list for a week.
export async function GET(req: Request) {
  const context = await currentHouseholdContext();
  if (!context) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const weekPlanId = new URL(req.url).searchParams.get("weekPlanId");
  if (!weekPlanId) {
    return NextResponse.json({ error: "weekPlanId required" }, { status: 400 });
  }
  const list = await prisma.shoppingList.findFirst({
    where: { weekPlanId, weekPlan: { householdId: context.household.id } },
    include: { items: true },
  });
  if (!list) {
    const plan = await prisma.weekPlan.findFirst({
      where: { id: weekPlanId, householdId: context.household.id },
      select: { id: true },
    });
    if (!plan) return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  return NextResponse.json(list);
}

const PostInput = z.object({ weekPlanId: z.string().min(1) });

// POST /api/shopping — (re)generate the list for a week plan.
//
// The list is keyed by ingredient identity so it can be diffed against plan
// changes (§5): surviving items keep their checked state, new ingredients
// arrive unchecked, removed ones drop off.
export async function POST(req: Request) {
  const context = await currentHouseholdContext();
  if (!context) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const householdId = context.household.id;
  const parsed = PostInput.safeParse(await req.json());
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }
  const { weekPlanId } = parsed.data;

  const plan = await prisma.weekPlan.findFirst({
    where: { id: weekPlanId, householdId },
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
    where: { householdId },
    update: {},
    create: { householdId },
  });
  const pantry = await prisma.pantryItem.findMany({ where: { householdId } });
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

  // What's already on the list. Two things ride on this read: the checked state
  // of ingredients that survive the regeneration, and the hand-added lines
  // (§5) — kitchen roll, nappies — which no plan can produce and which a
  // rebuild would otherwise wipe out. `mergeManualItems` makes both decisions.
  const existing = await prisma.shoppingList.findUnique({
    where: { weekPlanId },
    include: { items: true },
  });
  const rows = mergeManualItems(aggregated, existing?.items ?? []);

  // Replace the item set atomically, carrying checked state and manual lines
  // forward. Still a delete-and-rebuild rather than a row-by-row diff: the
  // amounts on a derived line change with the plan and the household size, so
  // most surviving rows would need updating anyway, and one write of the whole
  // set is easier to reason about than three sets of deltas.
  const list = await prisma.$transaction(async (tx) => {
    const sl = await tx.shoppingList.upsert({
      where: { weekPlanId },
      update: { generatedAt: new Date() },
      create: { weekPlanId },
    });
    await tx.shoppingListItem.deleteMany({ where: { shoppingListId: sl.id } });
    await tx.shoppingListItem.createMany({
      data: rows.map((r) => ({ ...r, shoppingListId: sl.id })),
    });
    return tx.shoppingList.findUnique({
      where: { id: sl.id },
      include: { items: true },
    });
  });

  return NextResponse.json(list, { status: 200 });
}
