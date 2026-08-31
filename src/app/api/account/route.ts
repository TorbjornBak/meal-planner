import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { currentHouseholdContext, currentUser } from "@/lib/currentUser";
import { looksLikeEmail, normalizeEmail } from "@/lib/auth";
import { isMailConfigured } from "@/lib/mail";

/**
 * Your own account (§9), and your digest preference *here* (§9b).
 *
 * Name, address and password belong to the account and follow you between
 * households. The weekly-email opt-in does not: it belongs to the membership,
 * because the mail is about one household's week, and someone who cooks in two
 * kitchens can reasonably want to hear about one of them.
 */

/** The shape the Settings page reads. Never includes the password hash. */
function publicAccount(
  u: { id: string; email: string; name: string | null },
  household: { id: string; name: string; newsletterOptIn: boolean } | null,
) {
  return {
    id: u.id,
    email: u.email,
    name: u.name,
    household,
    // Kept at the top level as well: the settings card asks "does this
    // instance mail at all?" before it offers to send a preview.
    newsletterOptIn: household?.newsletterOptIn ?? false,
  };
}

async function activeHousehold() {
  const context = await currentHouseholdContext();
  if (!context) return null;

  const membership = await prisma.householdMembership.findUnique({
    where: {
      householdId_userId: { householdId: context.household.id, userId: context.user.id },
    },
    select: { newsletterOptIn: true },
  });

  return {
    id: context.household.id,
    name: context.household.name,
    newsletterOptIn: membership?.newsletterOptIn ?? false,
  };
}

// GET /api/account — who am I, where am I, and can this instance send mail (§9).
export async function GET() {
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  return NextResponse.json({
    ...publicAccount(user, await activeHousehold()),
    mailConfigured: isMailConfigured(),
  });
}

const Patch = z.object({
  name: z.string().max(120).nullish(),
  email: z.string().max(320).optional(),
  /** Applies to the active household's membership, not the account. */
  newsletterOptIn: z.boolean().optional(),
});

// PATCH /api/account — change my display name, address or digest opt-in.
export async function PATCH(req: Request) {
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const parsed = Patch.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid" }, { status: 400 });
  }

  const data: { name?: string | null; email?: string } = {};

  if (parsed.data.name !== undefined) {
    const name = parsed.data.name?.trim();
    data.name = name ? name : null;
  }

  if (parsed.data.email !== undefined) {
    const email = normalizeEmail(parsed.data.email);
    if (!looksLikeEmail(email)) {
      return NextResponse.json({ error: "invalid-email" }, { status: 400 });
    }
    if (email !== user.email) {
      const taken = await prisma.user.findUnique({ where: { email } });
      if (taken) return NextResponse.json({ error: "email-taken" }, { status: 409 });
      data.email = email;
    }
  }

  if (parsed.data.newsletterOptIn !== undefined) {
    const context = await currentHouseholdContext();
    if (!context) {
      return NextResponse.json({ error: "no-household" }, { status: 409 });
    }
    await prisma.householdMembership.update({
      where: {
        householdId_userId: { householdId: context.household.id, userId: user.id },
      },
      data: { newsletterOptIn: parsed.data.newsletterOptIn },
    });
  }

  const updated = await prisma.user.update({ where: { id: user.id }, data });
  return NextResponse.json(publicAccount(updated, await activeHousehold()));
}
