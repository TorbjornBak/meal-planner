import { NextResponse } from "next/server";
import { z } from "zod";
import { currentHouseholdContext } from "@/lib/currentUser";
import { looksLikeEmail, normalizeEmail } from "@/lib/auth";
import { describeMailError } from "@/lib/mailError";
import {
  invitationUrl,
  isAlreadyMember,
  issueInvitation,
  listPendingInvitations,
  revokeInvitation,
  sendInvitationMail,
} from "@/lib/invitationService";

/**
 * Household invitations (§9).
 *
 * Everything here is scoped to the browser's active household and restricted
 * to its admins. Installation-wide invitations — the kind that create a new
 * household — are a platform admin's, and live under /api/admin/invitations.
 */

// GET /api/invitations — who this household is still waiting on.
export async function GET() {
  const context = await currentHouseholdContext();
  if (!context) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (context.role !== "ADMIN") {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  return NextResponse.json(await listPendingInvitations(context.household.id));
}

const Invite = z.object({
  email: z.string().min(1).max(320),
  name: z.string().max(120).optional(),
});

/**
 * POST /api/invitations — invite an address into this household.
 *
 * Nothing is created for the invitee here: no account, no membership, no row
 * in the roster. Only an offer with an expiry on it, which is what makes
 * withdrawing one possible and what stops a household's member list filling
 * with people who never answered.
 *
 * Answers 201 with `{ invitation, delivered, inviteUrl? }`. `inviteUrl` appears
 * only when there was no mail server to send it with: when the mail did go out
 * the link is already where it belongs, and putting a live credential in a
 * second place is pure risk.
 */
export async function POST(req: Request) {
  const context = await currentHouseholdContext();
  if (!context) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (context.role !== "ADMIN") {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const parsed = Invite.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "invalid" }, { status: 400 });

  const email = normalizeEmail(parsed.data.email);
  if (!looksLikeEmail(email)) {
    return NextResponse.json({ error: "invalid-email" }, { status: 400 });
  }
  if (await isAlreadyMember(email, context.household.id)) {
    return NextResponse.json({ error: "already-a-member" }, { status: 409 });
  }

  const { invitation, token } = await issueInvitation({
    email,
    invitedName: parsed.data.name,
    kind: "HOUSEHOLD",
    householdId: context.household.id,
    invitedById: context.user.id,
  });

  const pending = {
    id: invitation.id,
    email: invitation.email,
    invitedName: invitation.invitedName,
    kind: invitation.kind,
    invitedBy: context.user.name ?? context.user.email,
    expiresAt: invitation.expiresAt,
    createdAt: invitation.createdAt,
  };

  let delivered: boolean;
  try {
    delivered = await sendInvitationMail({
      invitation,
      token,
      invitedBy: context.user.name || context.user.email,
      householdName: context.household.name,
    });
  } catch (err) {
    // The invitation stands — the row is the offer — but the person who can
    // fix the relay is the one reading this, so say what went wrong rather
    // than quietly handing over a link and letting SMTP stay broken.
    console.error("invitation mail failed", err);
    const diagnosis = describeMailError(err, process.env.SMTP_HOST);
    return NextResponse.json(
      { invitation: pending, error: "mail-failed", ...diagnosis },
      { status: 502 },
    );
  }

  return NextResponse.json(
    {
      invitation: pending,
      delivered,
      ...(delivered
        ? {}
        : { inviteUrl: invitationUrl(token, new URL(req.url).origin) }),
    },
    { status: 201 },
  );
}

/**
 * DELETE /api/invitations?id=… — withdraw one.
 *
 * Scoped to the active household, so an admin of one household cannot revoke
 * another's invitation by guessing an id. An already-spent or already-revoked
 * link answers 409 rather than pretending: "it was accepted an hour ago" and
 * "it is now withdrawn" are different pieces of news.
 */
export async function DELETE(req: Request) {
  const context = await currentHouseholdContext();
  if (!context) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (context.role !== "ADMIN") {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const id = new URL(req.url).searchParams.get("id");
  if (!id) return NextResponse.json({ error: "invalid" }, { status: 400 });

  const revoked = await revokeInvitation({ id, householdId: context.household.id });
  if (!revoked) return NextResponse.json({ error: "not-pending" }, { status: 409 });

  return NextResponse.json({ ok: true });
}
