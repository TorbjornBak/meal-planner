import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { currentHouseholdContext } from "@/lib/currentUser";
import { INVITE_TTL_MS, issueAuthToken, looksLikeEmail, normalizeEmail } from "@/lib/auth";
import { MailNotConfiguredError, appUrl, isMailConfigured, sendMail } from "@/lib/mail";
import { inviteEmail } from "@/lib/emails";
import { describeMailError } from "@/lib/mailError";

/**
 * Household members (§9).
 *
 * The roster is private to the active household. Household administration is
 * separate from installation-wide platform administration.
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
      createdAt: true,
      user: {
        select: {
          id: true,
          email: true,
          name: true,
          newsletterOptIn: true,
          passwordHash: true,
          lastLoginAt: true,
        },
      },
    },
  });

  return NextResponse.json(
    memberships.map((membership) => ({
      ...membership.user,
      role: membership.role,
      createdAt: membership.createdAt,
      pending: membership.user.passwordHash === null,
      passwordHash: undefined,
      isMe: membership.user.id === context.user.id,
    })),
  );
}

const Invite = z.object({
  email: z.string().min(1).max(320),
  name: z.string().max(120).optional(),
});

/**
 * The address an invitee opens — /reset/<token>, the very page the emailed
 * invitation links to.
 *
 * APP_URL first, so a household that has published a name for the box hands
 * out that name whether or not the link happens to be travelling by email.
 * Without APP_URL we fall back to the origin this request arrived on: it came
 * from a member's browser, and every member reaches the box by the same
 * MagicDNS name on the tailnet (§10), so what worked for the inviter works for
 * the invitee. That fallback can read as loopback behind a proxy — the same
 * caveat the unsubscribe redirect carries — but the link is being shown to a
 * person who can see the host is wrong and fix it, not fired into a mailbox.
 */
function inviteUrl(req: Request, token: string): string {
  const path = `/reset/${token}`;
  try {
    return appUrl(path);
  } catch {
    return new URL(path, new URL(req.url).origin).toString();
  }
}

/**
 * POST /api/users — invite someone by email.
 *
 * Creates the account with no password and mails a link to choose one. Sending
 * it again to an address that's still pending simply re-issues the link, which
 * is what "resend invite" does.
 *
 * An instance with no SMTP server still invites. Mail is how the link usually
 * travels, not what makes it valid — the account and its INVITE token are
 * database rows either way (§9). Refusing here used to mean a household that
 * hadn't wired up SMTP could create exactly one account at /setup and then
 * never add the person they share the kitchen with. So when there's nothing to
 * send with, the link comes back in the response instead and the member passes
 * it on themselves. Everything else in the app degrades this way; invitation
 * was the one path that couldn't.
 *
 * Answers `{ user, delivered, inviteUrl? }` — a 201 either way, because a
 * member row is created either way. `inviteUrl` appears only on the
 * undelivered branch: when the mail did go out, the link is already where it
 * belongs and putting a live credential in a second place is pure risk.
 */
export async function POST(req: Request) {
  const context = await currentHouseholdContext();
  if (!context) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (context.role !== "ADMIN") {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const parsed = Invite.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid" }, { status: 400 });
  }

  const email = normalizeEmail(parsed.data.email);
  if (!looksLikeEmail(email)) {
    return NextResponse.json({ error: "invalid-email" }, { status: 400 });
  }

  const existing = await prisma.user.findUnique({ where: { email } });
  const existingMembership = existing
    ? await prisma.householdMembership.findUnique({
        where: {
          householdId_userId: {
            householdId: context.household.id,
            userId: existing.id,
          },
        },
      })
    : null;
  if (existingMembership || existing?.passwordHash) {
    return NextResponse.json({ error: "already-a-member" }, { status: 409 });
  }

  const user =
    existing
      ? await prisma.user.update({
          where: { id: existing.id },
          data: {
            memberships: {
              create: { householdId: context.household.id, role: "ADMIN" },
            },
          },
        })
      : await prisma.user.create({
          data: {
            email,
            name: parsed.data.name?.trim() || null,
            memberships: {
              create: { householdId: context.household.id, role: "ADMIN" },
            },
          },
        });

  const token = await issueAuthToken(user.id, "INVITE", INVITE_TTL_MS);

  // Shaped like a row of the GET roster, so the card can render the new member
  // without waiting for a reload.
  const member = {
    id: user.id,
    email: user.email,
    name: user.name,
    newsletterOptIn: user.newsletterOptIn,
    pending: true,
    lastLoginAt: null,
    createdAt: user.createdAt,
    isMe: false,
  };

  if (isMailConfigured()) {
    try {
      const mail = inviteEmail({
        name: user.name,
        token,
        invitedBy: context.user.name || context.user.email,
      });
      await sendMail({ to: user.email, ...mail });
      return NextResponse.json({ user: member, delivered: true }, { status: 201 });
    } catch (err) {
      // A configuration that vanished between the check and the send (an
      // empty APP_URL, say) isn't a delivery failure — it's the no-mail case
      // arriving late, so fall through and hand the link back.
      if (!(err instanceof MailNotConfiguredError)) {
        console.error("invite mail failed", err);
        // The invitee can't act on a mail that never arrived, so unlike the
        // forgot-password route this one admits the failure — and says what
        // went wrong, because the person reading it is the one who can fix the
        // setting. A working relay that refused this message is a fault to
        // repair, not a reason to start passing links around by hand.
        const diagnosis = describeMailError(err, process.env.SMTP_HOST);
        return NextResponse.json({ error: "mail-failed", ...diagnosis }, { status: 502 });
      }
    }
  }

  return NextResponse.json(
    { user: member, inviteUrl: inviteUrl(req, token), delivered: false },
    { status: 201 },
  );
}

/**
 * DELETE /api/users?id=… — remove a member.
 *
 * Their sessions and tokens cascade away with the row, so removal takes effect
 * on their very next request. The last account can't be deleted: an instance
 * with no users would fall back to open first-run setup (§9).
 */
export async function DELETE(req: Request) {
  const context = await currentHouseholdContext();
  if (!context) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (context.role !== "ADMIN") {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const id = new URL(req.url).searchParams.get("id");
  if (!id) return NextResponse.json({ error: "invalid" }, { status: 400 });

  const membership = await prisma.householdMembership.findUnique({
    where: {
      householdId_userId: { householdId: context.household.id, userId: id },
    },
  });
  if (!membership) return NextResponse.json({ error: "not found" }, { status: 404 });
  if (membership.role === "ADMIN") {
    return NextResponse.json({ error: "protected-admin" }, { status: 409 });
  }

  await prisma.householdMembership.delete({
    where: {
      householdId_userId: { householdId: context.household.id, userId: id },
    },
  });
  return NextResponse.json({ ok: true });
}
