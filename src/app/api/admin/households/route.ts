import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { guardOperational } from "@/lib/opsGuard";

/**
 * GET /api/admin/households — every household, as metadata only (§9c).
 *
 * The boundary this route exists to hold is what it does *not* select. There
 * is no recipe here, no plan, no shopping list, no receipt and no total. A
 * platform admin can see that a household exists, how many people can get into
 * it, how many of those can administer it, and when anybody last signed in —
 * which is everything an intervention needs and nothing a nosy operator would
 * want. Somebody who wants to know what this household eats has to be invited
 * into it like anybody else.
 *
 * Widening this select is the easiest possible way to undo §9c, so anything
 * added here should have to justify itself against "which intervention needs
 * this?".
 */
export async function GET() {
  const guard = await guardOperational();
  if (!guard.ok) return guard.response;

  const households = await prisma.household.findMany({
    orderBy: { createdAt: "asc" },
    select: {
      id: true,
      name: true,
      createdAt: true,
      memberships: {
        orderBy: { createdAt: "asc" },
        select: {
          role: true,
          createdAt: true,
          user: { select: { id: true, email: true, name: true, lastLoginAt: true } },
        },
      },
      _count: { select: { invitations: true } },
    },
  });

  return NextResponse.json(
    households.map((household) => {
      const members = household.memberships.map((m) => ({
        id: m.user.id,
        email: m.user.email,
        name: m.user.name,
        role: m.role,
        joinedAt: m.createdAt,
        lastLoginAt: m.user.lastLoginAt,
      }));

      return {
        id: household.id,
        name: household.name,
        createdAt: household.createdAt,
        members,
        adminCount: members.filter((m) => m.role === "ADMIN").length,
        // A household with members but no admin is the state this whole screen
        // exists for, so it is computed here rather than left to the eye.
        strandedWithoutAdmin:
          members.length > 0 && members.every((m) => m.role !== "ADMIN"),
      };
    }),
  );
}
