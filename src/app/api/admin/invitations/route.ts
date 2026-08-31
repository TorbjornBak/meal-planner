import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { looksLikeEmail, normalizeEmail } from "@/lib/auth";
import { guardOperational } from "@/lib/opsGuard";
import { recordAudit } from "@/lib/audit";
import { describeMailError } from "@/lib/mailError";
import {
  invitationUrl,
  issueInvitation,
  listPendingInvitations,
  revokeInvitation,
  sendInvitationMail,
} from "@/lib/invitationService";

/**
 * Platform invitations — offering somebody a household of their own (§9, §9c).
 *
 * The one thing that grows the installation, and therefore the platform
 * admin's alone. A household admin can bring somebody into their kitchen
 * (/api/invitations); only this can create a new kitchen, and accepting one
 * makes the invitee its first admin without giving them anything anywhere else.
 */

// GET /api/admin/invitations — platform invitations nobody has answered yet.
export async function GET() {
  const guard = await guardOperational();
  if (!guard.ok) return guard.response;

  return NextResponse.json(await listPendingInvitations(null));
}

const Invite = z.object({
  email: z.string().min(1).max(320),
  name: z.string().max(120).optional(),
  /** A suggestion; the invitee may call their household something else. */
  householdName: z.string().max(120).optional(),
});

// POST /api/admin/invitations — invite somebody to start a household.
export async function POST(req: Request) {
  const guard = await guardOperational();
  if (!guard.ok) return guard.response;
  const actor = guard.user;
  if (!actor) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const parsed = Invite.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "invalid" }, { status: 400 });

  const email = normalizeEmail(parsed.data.email);
  if (!looksLikeEmail(email)) {
    return NextResponse.json({ error: "invalid-email" }, { status: 400 });
  }

  // Not an error, and not a duplicate to refuse: somebody who already has an
  // account here can perfectly well be given a household of their own, and
  // accepting will attach it to the account they already have. What would be
  // wrong is silently doing it twice, and issueInvitation supersedes for that.
  const { invitation, token } = await issueInvitation({
    email,
    invitedName: parsed.data.name,
    kind: "PLATFORM",
    householdName: parsed.data.householdName,
    invitedById: actor.id,
  });

  const pending = {
    id: invitation.id,
    email: invitation.email,
    invitedName: invitation.invitedName,
    kind: invitation.kind,
    householdName: invitation.householdName,
    invitedBy: actor.name ?? actor.email,
    expiresAt: invitation.expiresAt,
    createdAt: invitation.createdAt,
  };

  await recordAudit({
    action: "PLATFORM_INVITATION_SENT",
    actor: { id: actor.id, email: actor.email },
    subjectEmail: email,
    detail: `Invited ${email} to set up a household${
      invitation.householdName ? ` called ${invitation.householdName}` : ""
    }.`,
  });

  let delivered: boolean;
  try {
    delivered = await sendInvitationMail({
      invitation,
      token,
      invitedBy: actor.name || actor.email,
      householdName: null,
    });
  } catch (err) {
    console.error("platform invitation mail failed", err);
    return NextResponse.json(
      {
        invitation: pending,
        error: "mail-failed",
        ...describeMailError(err, process.env.SMTP_HOST),
      },
      { status: 502 },
    );
  }

  return NextResponse.json(
    {
      invitation: pending,
      delivered,
      ...(delivered ? {} : { inviteUrl: invitationUrl(token, new URL(req.url).origin) }),
    },
    { status: 201 },
  );
}

// DELETE /api/admin/invitations?id=… — withdraw one.
export async function DELETE(req: Request) {
  const guard = await guardOperational();
  if (!guard.ok) return guard.response;
  const actor = guard.user;
  if (!actor) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const id = new URL(req.url).searchParams.get("id");
  if (!id) return NextResponse.json({ error: "invalid" }, { status: 400 });

  // Read it first, so the audit record can name the address rather than an id
  // that will mean nothing to anyone reading the trail later. Scoped to
  // householdId: null, which is what makes this the platform list and not a
  // way to reach into a household's own invitations from outside.
  const invitation = await prisma.invitation.findFirst({
    where: { id, householdId: null },
    select: { email: true },
  });

  const revoked = await revokeInvitation({ id, householdId: null });
  if (!revoked) return NextResponse.json({ error: "not-pending" }, { status: 409 });

  await recordAudit({
    action: "PLATFORM_INVITATION_REVOKED",
    actor: { id: actor.id, email: actor.email },
    subjectEmail: invitation?.email ?? null,
    detail: `Withdrew the invitation to ${invitation?.email ?? "an unknown address"}.`,
  });

  return NextResponse.json({ ok: true });
}
