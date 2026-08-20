import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { currentUser } from "@/lib/currentUser";
import { INVITE_TTL_MS, issueAuthToken, looksLikeEmail, normalizeEmail } from "@/lib/auth";
import { isMailConfigured, sendMail } from "@/lib/mail";
import { inviteEmail } from "@/lib/emails";
import { describeMailError } from "@/lib/mailError";

/**
 * Household members (§9).
 *
 * Every member is equal — there are no roles or admins. A household is a
 * handful of people who already share a kitchen; anyone who can sign in can
 * invite and remove, the same way anyone can edit the shopping list.
 */

// GET /api/users — the household roster.
export async function GET() {
  const me = await currentUser();
  if (!me) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const users = await prisma.user.findMany({
    orderBy: { createdAt: "asc" },
    select: {
      id: true,
      email: true,
      name: true,
      newsletterOptIn: true,
      passwordHash: true,
      lastLoginAt: true,
      createdAt: true,
    },
  });

  return NextResponse.json(
    users.map((u) => ({
      id: u.id,
      email: u.email,
      name: u.name,
      newsletterOptIn: u.newsletterOptIn,
      // Never the hash itself — only whether they've finished signing up.
      pending: u.passwordHash === null,
      lastLoginAt: u.lastLoginAt,
      createdAt: u.createdAt,
      isMe: u.id === me.id,
    })),
  );
}

const Invite = z.object({
  email: z.string().min(1).max(320),
  name: z.string().max(120).optional(),
});

/**
 * POST /api/users — invite someone by email.
 *
 * Creates the account with no password and mails a link to choose one. Sending
 * it again to an address that's still pending simply re-issues the link, which
 * is what "resend invite" does.
 */
export async function POST(req: Request) {
  const me = await currentUser();
  if (!me) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  if (!isMailConfigured()) {
    return NextResponse.json({ error: "mail-not-configured" }, { status: 503 });
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
  if (existing?.passwordHash) {
    return NextResponse.json({ error: "already-a-member" }, { status: 409 });
  }

  const user =
    existing ??
    (await prisma.user.create({
      data: { email, name: parsed.data.name?.trim() || null },
    }));

  const token = await issueAuthToken(user.id, "INVITE", INVITE_TTL_MS);
  const mail = inviteEmail({
    name: user.name,
    token,
    invitedBy: me.name || me.email,
  });

  try {
    await sendMail({ to: user.email, ...mail });
  } catch (err) {
    console.error("invite mail failed", err);
    // The invitee can't act on a mail that never arrived, so unlike the
    // forgot-password route this one admits the failure — and says what went
    // wrong, because the person reading it is the one who can fix the setting.
    const diagnosis = describeMailError(err, process.env.SMTP_HOST);
    return NextResponse.json({ error: "mail-failed", ...diagnosis }, { status: 502 });
  }

  return NextResponse.json({
    id: user.id,
    email: user.email,
    name: user.name,
    newsletterOptIn: user.newsletterOptIn,
    pending: true,
    lastLoginAt: null,
    createdAt: user.createdAt,
    isMe: false,
  });
}

/**
 * DELETE /api/users?id=… — remove a member.
 *
 * Their sessions and tokens cascade away with the row, so removal takes effect
 * on their very next request. The last account can't be deleted: an instance
 * with no users would fall back to open first-run setup (§9).
 */
export async function DELETE(req: Request) {
  const me = await currentUser();
  if (!me) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const id = new URL(req.url).searchParams.get("id");
  if (!id) return NextResponse.json({ error: "invalid" }, { status: 400 });

  if ((await prisma.user.count()) <= 1) {
    return NextResponse.json({ error: "last-member" }, { status: 409 });
  }

  await prisma.user.delete({ where: { id } }).catch(() => {});
  return NextResponse.json({ ok: true });
}
