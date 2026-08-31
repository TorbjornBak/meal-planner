import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { ingredientKey } from "@/lib/keys";
import { currentHouseholdContext } from "@/lib/currentUser";

/**
 * Adding a line to the shopping list by hand (§5, §6).
 *
 * Everything else on the list is derived from the week's dinners, but the trip
 * to the shop isn't: kitchen roll, nappies and the milk nobody cooks with have
 * to go somewhere, and until they could go here they went on a second list on
 * somebody's phone — which defeats the one shared checklist §6 is for.
 *
 * This is a collection endpoint (create against the week's list), so it can't
 * live at /api/shopping/[itemId], which addresses a row that already exists;
 * and POST /api/shopping already means "regenerate the whole list", which is a
 * different verb on a different thing. Removal, by contrast, *is* an operation
 * on one existing row, so DELETE sits next to PATCH in [itemId]/route.ts.
 *
 * Next resolves the literal "items" segment ahead of the [itemId] pattern, so
 * this shadows an item whose id is exactly "items". Ids are cuids; they aren't.
 */

const PostInput = z.object({
  weekPlanId: z.string().min(1),
  // Just a name. Amounts are a recipe's business — the manual lines are the
  // ones you buy by the packet, and "kitchen roll x2" typed into the name
  // reads better in the aisle than a quantity field would.
  name: z.string().min(1),
});

// POST /api/shopping/items — add a hand-written line to a week's list.
export async function POST(req: Request) {
  const context = await currentHouseholdContext();
  if (!context) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const parsed = PostInput.safeParse(await req.json());
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }
  const { weekPlanId } = parsed.data;
  const name = parsed.data.name.trim();

  // Normalized with the same key as recipe lines (§5) so a hand-typed "Milk"
  // is the same thing as a recipe's "milk": it merges on the next generation
  // instead of doubling up, and it matches the pantry list the same way.
  const key = ingredientKey(name);
  if (!key) {
    return NextResponse.json(
      { error: "an item needs a name with letters or numbers in it" },
      { status: 400 },
    );
  }

  const plan = await prisma.weekPlan.findFirst({
    where: { id: weekPlanId, householdId: context.household.id },
  });
  if (!plan) {
    return NextResponse.json({ error: "week plan not found" }, { status: 404 });
  }

  // Create the list if the week hasn't generated one yet: remembering the
  // kitchen roll shouldn't have to wait until someone has planned a dinner.
  const list = await prisma.shoppingList.upsert({
    where: { weekPlanId },
    update: {},
    create: { weekPlanId },
  });

  const existing = await prisma.shoppingListItem.findUnique({
    where: { shoppingListId_ingredientKey: { shoppingListId: list.id, ingredientKey: key } },
  });
  if (existing) {
    // Already on the list — as a derived line, or because the other phone
    // added it a minute ago. Return it rather than erroring, and leave it
    // exactly as it is: flipping a recipe-derived line to manual would make it
    // deletable, and it would come back on the next generation anyway. 200
    // rather than 201 so the page can say "that's already on the list".
    return NextResponse.json(existing, { status: 200 });
  }

  try {
    const item = await prisma.shoppingListItem.create({
      data: {
        shoppingListId: list.id,
        ingredientKey: key,
        displayName: name,
        isManual: true,
        // Not filed under "check you have these", even if the name matches a
        // pantry staple. Typing "salt" onto the list is the household saying
        // it has actually run out (§5); the pantry section would bury it.
        isPantry: false,
      },
    });
    return NextResponse.json(item, { status: 201 });
  } catch {
    // Two phones adding the same thing at once: the unique key on
    // (list, ingredientKey) settles it, and either way the item is now there.
    const raced = await prisma.shoppingListItem.findUnique({
      where: { shoppingListId_ingredientKey: { shoppingListId: list.id, ingredientKey: key } },
    });
    if (raced) return NextResponse.json(raced, { status: 200 });
    return NextResponse.json({ error: "couldn't add that item" }, { status: 500 });
  }
}
