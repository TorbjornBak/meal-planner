import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";

// Weekly dinner plan (§3, §4).

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
// 7 dinner slots. Defaults to the current week.
export async function GET(req: Request) {
  const raw = new URL(req.url).searchParams.get("weekStart");
  const weekStart = mondayOf(raw ? new Date(raw) : new Date());

  const plan = await prisma.weekPlan.upsert({
    where: { weekStart },
    update: {},
    create: {
      weekStart,
      slots: { create: Array.from({ length: 7 }, (_, dayOfWeek) => ({ dayOfWeek })) },
    },
    include: {
      slots: { orderBy: { dayOfWeek: "asc" }, include: { recipe: true } },
    },
  });

  return NextResponse.json(plan);
}

const SlotInput = z.object({
  weekPlanId: z.string().min(1),
  dayOfWeek: z.number().int().min(0).max(6),
  recipeId: z.string().nullable(),
  servingsOverride: z.number().int().positive().nullable().optional(),
});

// PATCH /api/plan — assign (or clear) a recipe on a dinner slot, with an
// optional per-slot servings override (§4).
export async function PATCH(req: Request) {
  const parsed = SlotInput.safeParse(await req.json());
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }
  const { weekPlanId, dayOfWeek, recipeId, servingsOverride } = parsed.data;

  const slot = await prisma.dinnerSlot.update({
    where: { weekPlanId_dayOfWeek: { weekPlanId, dayOfWeek } },
    data: { recipeId, servingsOverride: servingsOverride ?? null },
    include: { recipe: true },
  });

  return NextResponse.json(slot);
}
