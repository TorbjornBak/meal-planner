import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { currentHouseholdContext } from "@/lib/currentUser";
import { memberRemovalRefusal } from "@/lib/invitations";

/**
 * The household roster (§9).
 *
 * Private to the active household, and separate from installation-wide
 * platform administration. Inviting somebody is no longer done here: an
 * invitation creates nothing until it is accepted, so it has its own endpoint
 * (/api/invitations) and its own list. What is left is who is actually in.
 */

// GET /api/users — the household roster.
export async function GET() {
  const context = await currentHouseholdContext();
  if (!context) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const memberships = await prisma.householdMembership.findMany({
    where: { householdId: context.household.id },
    orderBy: { createdAt: "asc" },
    select: {
      role: true,
      newsletterOptIn: true,
      createdAt: true,
      user: {
        select: {
          id: true,
          email: true,
          name: true,
          passwordHash: true,
          lastLoginAt: true,
        },
      },
    },
  });

  return NextResponse.json(
    memberships.map((membership) => ({
      id: membership.user.id,
      email: membership.user.email,
      name: membership.user.name,
      lastLoginAt: membership.user.lastLoginAt,
      newsletterOptIn: membership.newsletterOptIn,
      role: membership.role,
      createdAt: membership.createdAt,
      // A member from before invitations were rows of their own: the account
      // was created up front and has never had a password chosen for it.
      pending: membership.user.passwordHash === null,
      isMe: membership.user.id === context.user.id,
      // What the interface may offer, decided here rather than re-derived in
      // the browser, where it would be a suggestion rather than a rule.
      removable:
        memberRemovalRefusal({
          actor: { userId: context.user.id, role: context.role },
          target: { userId: membership.user.id, role: membership.role },
        }) === null,
    })),
  );
}

/**
 * DELETE /api/users?id=… — remove a member from this household.
 *
 * Their account survives; only the membership goes, and with it the session's
 * ability to act in this household — the composite foreign key on Session
 * cascades, so a removed member stops seeing this household's data on their
 * very next request rather than whenever their cookie lapses.
 *
 * Admins are equals and cannot remove one another (see memberRemovalRefusal).
 * Leaving a household yourself is a different act with a different warning and
 * is not this button.
 */
export async function DELETE(req: Request) {
  const context = await currentHouseholdContext();
  if (!context) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const id = new URL(req.url).searchParams.get("id");
  if (!id) return NextResponse.json({ error: "invalid" }, { status: 400 });

  const membership = await prisma.householdMembership.findUnique({
    where: { householdId_userId: { householdId: context.household.id, userId: id } },
    select: { role: true },
  });

  const refusal = memberRemovalRefusal({
    actor: { userId: context.user.id, role: context.role },
    target: membership ? { userId: id, role: membership.role } : null,
  });

  if (refusal === "not-admin") return NextResponse.json({ error: refusal }, { status: 403 });
  if (refusal === "not-a-member") return NextResponse.json({ error: refusal }, { status: 404 });
  if (refusal) return NextResponse.json({ error: refusal }, { status: 409 });

  await prisma.householdMembership.delete({
    where: { householdId_userId: { householdId: context.household.id, userId: id } },
  });
  return NextResponse.json({ ok: true });
}
