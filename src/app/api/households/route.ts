import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { currentHouseholdContext } from "@/lib/currentUser";

/**
 * GET /api/households — the households this account can act in (§9).
 *
 * What the switcher is built from. Only ever the caller's own memberships:
 * belonging to one household tells you nothing about how many others exist,
 * and this endpoint keeps it that way.
 */
export async function GET() {
  const context = await currentHouseholdContext();
  if (!context) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const memberships = await prisma.householdMembership.findMany({
    where: { userId: context.user.id },
    orderBy: [{ createdAt: "asc" }, { householdId: "asc" }],
    select: {
      role: true,
      newsletterOptIn: true,
      household: { select: { id: true, name: true } },
    },
  });

  return NextResponse.json({
    activeId: context.household.id,
    households: memberships.map((m) => ({
      id: m.household.id,
      name: m.household.name,
      role: m.role,
      newsletterOptIn: m.newsletterOptIn,
      active: m.household.id === context.household.id,
    })),
  });
}

/**
 * PATCH /api/households — rename the active household.
 *
 * An admin's, because the name is what every other member sees at the top of
 * the switcher and in the subject line of their weekly mail.
 */
export async function PATCH(req: Request) {
  const context = await currentHouseholdContext();
  if (!context) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (context.role !== "ADMIN") {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const body = (await req.json().catch(() => null)) as { name?: unknown } | null;
  const name = typeof body?.name === "string" ? body.name.trim() : "";
  if (!name || name.length > 120) {
    return NextResponse.json({ error: "invalid" }, { status: 400 });
  }

  const household = await prisma.household.update({
    where: { id: context.household.id },
    data: { name },
    select: { id: true, name: true },
  });

  return NextResponse.json(household);
}
