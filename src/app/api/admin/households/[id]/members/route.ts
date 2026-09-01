import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { guardOperational } from "@/lib/opsGuard";
import { recordAudit } from "@/lib/audit";
import { removalInterventionRefusal, roleInterventionRefusal } from "@/lib/platformAdmin";
import { rotateCaptureKey } from "@/lib/auth";

/**
 * Reaching into one household's membership (§9c).
 *
 * The narrow intervention the plan asks for, and the escape hatch for a rule
 * that is right but incomplete: household admins are equals and cannot demote
 * or remove one another, which stops two people racing each other out of a
 * shared kitchen but leaves a deadlocked household — or one whose only admin
 * has lost their mailbox — unable to fix itself. Somebody outside has to be
 * able to act, and every time they do it is written down.
 *
 * Membership only. There is no route here that reads a plan or a recipe.
 */

async function loadHousehold(id: string) {
  return prisma.household.findUnique({
    where: { id },
    select: {
      id: true,
      name: true,
      memberships: { select: { userId: true, role: true } },
    },
  });
}

type Household = NonNullable<Awaited<ReturnType<typeof loadHousehold>>>;

/** The membership row for `userId` in `household`, if they're a member. */
function findMembership(household: Household, userId: string) {
  return household.memberships.find((m) => m.userId === userId) ?? null;
}

/**
 * The email to name in an audit sentence and, where the action calls for it,
 * in `subjectEmail` — both handlers below load the household's own
 * membership rows, which carry a `userId` but not an email, and need one
 * more query for a sentence a person can read.
 */
async function subjectEmailFor(userId: string): Promise<string | null> {
  const subject = await prisma.user.findUnique({
    where: { id: userId },
    select: { email: true },
  });
  return subject?.email ?? null;
}

const Patch = z.object({
  userId: z.string().min(1).max(60),
  role: z.enum(["MEMBER", "ADMIN"]),
});

/** PATCH — grant or withdraw household admin, on behalf of a stuck household. */
export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const guard = await guardOperational();
  if (!guard.ok) return guard.response;
  // guardOperational() is called here with no { bearer: true }, so guard.ok
  // can only be true with a non-null user — operationalCaller only allows a
  // null user through in bearer mode. Kept anyway, in the style of the guards
  // around it, so this doesn't quietly start relying on that invariant if
  // this handler is ever changed to accept a bearer-authenticated caller too.
  const actor = guard.user;
  if (!actor) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const { id } = await ctx.params;
  const parsed = Patch.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "invalid" }, { status: 400 });

  const household = await loadHousehold(id);
  if (!household) return NextResponse.json({ error: "not-found" }, { status: 404 });

  const target = findMembership(household, parsed.data.userId);
  const refusal = roleInterventionRefusal({
    caller: { platformRole: actor.platformRole },
    target: target ? { role: target.role } : null,
    nextRole: parsed.data.role,
    adminCount: household.memberships.filter((m) => m.role === "ADMIN").length,
  });

  if (refusal === "not-platform-admin") {
    return NextResponse.json({ error: refusal }, { status: 403 });
  }
  if (refusal === "not-a-member") {
    return NextResponse.json({ error: refusal }, { status: 404 });
  }
  if (refusal) return NextResponse.json({ error: refusal }, { status: 409 });
  if (target && target.role === parsed.data.role) {
    return NextResponse.json({ ok: true, unchanged: true });
  }

  const subjectEmail = await subjectEmailFor(parsed.data.userId);

  await prisma.householdMembership.update({
    where: { householdId_userId: { householdId: id, userId: parsed.data.userId } },
    data: { role: parsed.data.role },
  });

  await recordAudit({
    action: "HOUSEHOLD_ROLE_CHANGED",
    actor: { id: actor.id, email: actor.email },
    household: { id: household.id, name: household.name },
    subjectEmail,
    detail: `Made ${subjectEmail ?? parsed.data.userId} ${
      parsed.data.role === "ADMIN" ? "an admin of" : "an ordinary member of"
    } ${household.name}.`,
  });

  return NextResponse.json({ ok: true });
}

/**
 * DELETE ?userId=… — take somebody out of a household.
 *
 * No last-member guard, deliberately: removing the final member is how a
 * household is wound up, and refusing it would strand abandoned households on
 * the box with no way to clear them. The cost is a line in the audit trail
 * naming whoever did it.
 */
export async function DELETE(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const guard = await guardOperational();
  if (!guard.ok) return guard.response;
  // guardOperational() is called here with no { bearer: true }, so guard.ok
  // can only be true with a non-null user — operationalCaller only allows a
  // null user through in bearer mode. Kept anyway, in the style of the guards
  // around it, so this doesn't quietly start relying on that invariant if
  // this handler is ever changed to accept a bearer-authenticated caller too.
  const actor = guard.user;
  if (!actor) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const { id } = await ctx.params;
  const userId = new URL(req.url).searchParams.get("userId");
  if (!userId) return NextResponse.json({ error: "invalid" }, { status: 400 });

  const household = await loadHousehold(id);
  if (!household) return NextResponse.json({ error: "not-found" }, { status: 404 });

  const target = findMembership(household, userId);
  const refusal = removalInterventionRefusal({
    caller: { platformRole: actor.platformRole },
    target: target ? { role: target.role } : null,
  });

  if (refusal === "not-platform-admin") {
    return NextResponse.json({ error: refusal }, { status: 403 });
  }
  if (refusal) return NextResponse.json({ error: refusal }, { status: 404 });

  const subjectEmail = await subjectEmailFor(userId);

  // Same reasoning as the household's own removal route (§1): rotate the
  // bookmarklet capture key in the same transaction as the delete, so a
  // platform admin reaching in from outside revokes the old token as
  // atomically as an admin acting from inside the household does.
  await prisma.$transaction(async (tx) => {
    await tx.householdMembership.delete({
      where: { householdId_userId: { householdId: id, userId } },
    });
    await rotateCaptureKey(id, tx);
  });

  await recordAudit({
    action: "HOUSEHOLD_MEMBER_REMOVED",
    actor: { id: actor.id, email: actor.email },
    household: { id: household.id, name: household.name },
    subjectEmail,
    detail: `Removed ${subjectEmail ?? userId} from ${household.name}${
      target?.role === "ADMIN" ? ", who was an admin of it" : ""
    }.`,
  });

  return NextResponse.json({ ok: true });
}
