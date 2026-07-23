import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { OMIT_RECIPE_BLOBS } from "@/lib/recipeImage";

// Weekly dinner plan (§3, §4). A night can hold several dinners; an empty night
// simply has no slots.

/** Monday (UTC, date-only) of the week containing `d`. */
function mondayOf(d: Date): Date {
  const day = d.getUTCDay(); // 0 = Sun
  const diff = (day + 6) % 7; // days since Monday
  const monday = new Date(
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - diff),
  );
  return monday;
}

// GET /api/plan?weekStart=YYYY-MM-DD — fetch (or create) a week's plan with its
// dinner slots, ordered by day then position. Defaults to the current week.
export async function GET(req: Request) {
  const raw = new URL(req.url).searchParams.get("weekStart");
  const weekStart = mondayOf(raw ? new Date(raw) : new Date());

  const plan = await prisma.weekPlan.upsert({
    where: { weekStart },
    update: {},
    create: { weekStart },
    include: {
      slots: {
        orderBy: [{ dayOfWeek: "asc" }, { position: "asc" }],
        include: { recipe: { omit: OMIT_RECIPE_BLOBS } },
      },
    },
  });

  return NextResponse.json(plan);
}

const AddInput = z.object({
  weekPlanId: z.string().min(1),
  dayOfWeek: z.number().int().min(0).max(6),
  recipeId: z.string().min(1),
});

// POST /api/plan — add a dinner to a night. The new dinner lands after any
// dinners already on that night.
export async function POST(req: Request) {
  const parsed = AddInput.safeParse(await req.json());
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }
  const { weekPlanId, dayOfWeek, recipeId } = parsed.data;

  const position = await prisma.dinnerSlot.count({
    where: { weekPlanId, dayOfWeek },
  });
  const slot = await prisma.dinnerSlot.create({
    data: { weekPlanId, dayOfWeek, recipeId, position },
    include: { recipe: { omit: OMIT_RECIPE_BLOBS } },
  });

  return NextResponse.json(slot, { status: 201 });
}

const PatchInput = z.object({
  slotId: z.string().min(1),
  servingsOverride: z.number().int().positive().nullable(),
});

// PATCH /api/plan — set (or clear) a dinner's per-slot servings override (§4).
export async function PATCH(req: Request) {
  const parsed = PatchInput.safeParse(await req.json());
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }
  const { slotId, servingsOverride } = parsed.data;

  const slot = await prisma.dinnerSlot.update({
    where: { id: slotId },
    data: { servingsOverride },
    include: { recipe: { omit: OMIT_RECIPE_BLOBS } },
  });

  return NextResponse.json(slot);
}

// DELETE /api/plan?slotId=... — remove a dinner from its night.
export async function DELETE(req: Request) {
  const slotId = new URL(req.url).searchParams.get("slotId");
  if (!slotId) {
    return NextResponse.json({ error: "slotId required" }, { status: 400 });
  }
  await prisma.dinnerSlot.delete({ where: { id: slotId } });
  return NextResponse.json({ ok: true });
}
