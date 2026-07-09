import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";

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
  const { itemId } = await params;
  const parsed = PatchInput.safeParse(await req.json());
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }
  const item = await prisma.shoppingListItem.update({
    where: { id: itemId },
    data: parsed.data,
  });
  return NextResponse.json(item);
}
