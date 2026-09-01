import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { currentHouseholdContext } from "@/lib/currentUser";

// PATCH /api/shopping/[itemId] — toggle checked state (§6, shared across
// phones) or move an item between the main and pantry sections (§5).
const PatchInput = z.object({
  checked: z.boolean().optional(),
  isPantry: z.boolean().optional(),
});

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ itemId: string }> },
) {
  const context = await currentHouseholdContext();
  if (!context) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { itemId } = await params;
  const parsed = PatchInput.safeParse(await req.json());
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }
  const owned = await prisma.shoppingListItem.findFirst({
    where: {
      id: itemId,
      shoppingList: { weekPlan: { householdId: context.household.id } },
    },
    select: { id: true },
  });
  if (!owned) return NextResponse.json({ error: "item not found" }, { status: 404 });

  const item = await prisma.shoppingListItem.update({
    where: { id: owned.id },
    data: parsed.data,
  });
  return NextResponse.json(item);
}

// DELETE /api/shopping/[itemId] — remove a hand-added line (§5).
//
// It lives here, beside PATCH, because removing one row is the same kind of
// thing as ticking one off: an operation on an item that already exists, at
// the URL the checklist already talks to. Creating a manual line needs a
// collection URL instead — see /api/shopping/items.
//
// Only manual lines can go. A recipe-derived one is a view of the week's plan:
// deleting it would look like it worked and then hand the row straight back on
// the next generation, so we refuse and say what to do instead. The real ways
// to lose a derived line are to take the dinner off the plan, or to put the
// ingredient on the pantry list.
export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ itemId: string }> },
) {
  const context = await currentHouseholdContext();
  if (!context) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { itemId } = await params;
  const item = await prisma.shoppingListItem.findFirst({
    where: {
      id: itemId,
      shoppingList: { weekPlan: { householdId: context.household.id } },
    },
  });
  if (!item) {
    return NextResponse.json({ error: "item not found" }, { status: 404 });
  }
  if (!item.isManual) {
    return NextResponse.json(
      {
        error:
          `"${item.displayName}" comes from a dinner on this week's plan, so it would ` +
          `come back the next time the list is generated. Remove the dinner from the ` +
          `plan, or add it to your pantry list, instead.`,
      },
      { status: 409 },
    );
  }
  await prisma.shoppingListItem.delete({ where: { id: itemId } });
  return NextResponse.json({ ok: true });
}
