import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { currentHouseholdContext } from "@/lib/currentUser";

// Household settings (§4) — one row per household.

// GET /api/settings — current household size (created with defaults if absent).
export async function GET() {
  const context = await currentHouseholdContext();
  if (!context) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const householdId = context.household.id;
  const settings = await prisma.settings.upsert({
    where: { householdId },
    update: {},
    create: { householdId },
  });
  return NextResponse.json(settings);
}

const PatchInput = z.object({
  householdSize: z.number().int().positive(),
});

// PATCH /api/settings — change household size (rescales future lists).
export async function PATCH(req: Request) {
  const context = await currentHouseholdContext();
  if (!context) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const parsed = PatchInput.safeParse(await req.json());
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }
  const settings = await prisma.settings.upsert({
    where: { householdId: context.household.id },
    update: parsed.data,
    create: { householdId: context.household.id, ...parsed.data },
  });
  return NextResponse.json(settings);
}
