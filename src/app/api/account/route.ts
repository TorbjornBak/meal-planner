import { NextResponse } from "next/server";
import { z } from "zod";
import type { PlatformRole } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { currentHouseholdContext, currentUser } from "@/lib/currentUser";
import { looksLikeEmail, normalizeEmail } from "@/lib/auth";
import { verifyPassword } from "@/lib/password";
import { isMailConfigured, sendMail } from "@/lib/mail";
import { emailChangedEmail } from "@/lib/emails";
import { recordAudit } from "@/lib/audit";
import { consumeAll, tooManyRequests } from "@/lib/rateLimit";

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
  u: { id: string; email: string; name: string | null; platformRole: PlatformRole },
  household: { id: string; name: string; newsletterOptIn: boolean } | null,
) {
  return {
    id: u.id,
    email: u.email,
    name: u.name,
    household,
    // So the settings screen can stop offering buttons that would 403. The
    // authorization itself is the server's (§9c) — this only decides what is
    // worth drawing, and hiding a control has never been a way to protect it.
    isPlatformAdmin: u.platformRole === "ADMIN",
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
  /**
   * Only required, and only checked, when `email` is actually changing (see
   * below) — saving your display name must not start demanding a password.
   */
  currentPassword: z.string().min(1).max(200).optional(),
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
  // Set only when the address is actually about to change, so the mail and
  // the audit row below fire on a real change and not on a PATCH that merely
  // resubmitted the account's current address.
  let previousEmail: string | null = null;

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
      // The login address is what /api/password/forgot mails a reset link
      // to, so changing it with nothing but a cookie in hand is a full
      // account takeover: change the address, then use the forgot-password
      // flow to lock the real owner out of their own recovery path. Gated
      // exactly the way src/app/api/account/password/route.ts gates a
      // password change, and for the same reason — it's what stops a
      // borrowed or stolen session from doing this unattended.
      //
      // Same bucket as the password change, not a bucket of its own: both
      // are "grind the current password out of this field" attempts against
      // the same account, and rateLimitPolicy.ts's LIMITS table isn't ours to
      // extend here.
      const refusal = await consumeAll([["password-change:user", user.id]]);
      if (refusal) return tooManyRequests(refusal);

      if (!parsed.data.currentPassword) {
        return NextResponse.json({ error: "password-required" }, { status: 401 });
      }
      if (!(await verifyPassword(parsed.data.currentPassword, user.passwordHash))) {
        return NextResponse.json({ error: "wrong-password" }, { status: 401 });
      }

      const taken = await prisma.user.findUnique({ where: { email } });
      if (taken) return NextResponse.json({ error: "email-taken" }, { status: 409 });
      data.email = email;
      previousEmail = user.email;
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

  if (previousEmail) {
    // What an account takeover looks like from the outside starts here, the
    // same way it does for a password change: the row says the address
    // changed and what it changed from, which is the fact worth checking
    // first if the old address later reports being locked out.
    await recordAudit({
      action: "EMAIL_CHANGED",
      actor: { id: user.id, email: previousEmail },
      detail: `${previousEmail} changed their login address to ${updated.email}.`,
    });

    // Mail is optional on this installation (isMailConfigured) — the address
    // has already changed by this point regardless, so a missing SMTP config
    // degrades this to "no notice sent" rather than failing the request. The
    // notice goes to the OLD address on purpose: it's the one mailbox that is
    // guaranteed to belong to whoever owned the account before this request,
    // and the only place left to say "if this wasn't you" to.
    if (isMailConfigured()) {
      try {
        await sendMail({
          to: previousEmail,
          ...emailChangedEmail({ name: updated.name, newEmail: updated.email }),
        });
      } catch (err) {
        console.error("email change notice failed", err);
      }
    }
  }

  return NextResponse.json(publicAccount(updated, await activeHousehold()));
}
