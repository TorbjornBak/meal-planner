/**
 * Issuing, inspecting and spending invitations (§9).
 *
 * The rules live in src/lib/invitations.ts; this is the half that talks to
 * Postgres. Everything a route needs is one call here, because the interesting
 * parts — superseding the previous link, claiming a link exactly once, and
 * creating an account, a household and a membership together or not at all —
 * are transactions, and a transaction spread across a route handler is a
 * transaction somebody will one day forget half of.
 */

import { Prisma, type Invitation, type InvitationKind } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { generateToken, hashToken, normalizeEmail } from "@/lib/auth";
import { householdInviteEmail, platformInviteEmail } from "@/lib/emails";
import { MailNotConfiguredError, appUrl, isMailConfigured, sendMail } from "@/lib/mail";
import { recordAudit } from "@/lib/audit";
import {
  type AcceptancePlan,
  type AcceptanceRefusal,
  INVITATION_TTL_MS,
  INVITED_ROLE,
  acceptancePlan,
  acceptanceRefusal,
  invitationPath,
  invitationState,
  needsHouseholdName,
  needsPassword,
} from "@/lib/invitations";

/** An invitation plus the raw token, which exists only in this return value. */
export interface IssuedInvitation {
  invitation: Invitation;
  token: string;
}

/**
 * Mint a link, superseding whatever was outstanding for the same address and
 * the same target.
 *
 * "Creating a replacement revokes the previous unused one" is what makes
 * "resend the invitation" safe: without it, every resend would leave another
 * live seven-day credential in another copy of the same mail, and revoking the
 * invitation would mean revoking an unknown number of them. One address, one
 * target, at most one way in.
 *
 * The supersede and the insert share a transaction so a resend cannot be
 * interrupted into leaving zero live invitations — the state that looks, to
 * everyone involved, exactly like a link that simply never arrived.
 */
export async function issueInvitation(opts: {
  email: string;
  invitedName?: string | null;
  kind: InvitationKind;
  /** Required for HOUSEHOLD, and must be absent for PLATFORM. */
  householdId?: string | null;
  householdName?: string | null;
  invitedById: string;
  now?: Date;
}): Promise<IssuedInvitation> {
  const now = opts.now ?? new Date();
  const email = normalizeEmail(opts.email);
  const householdId = opts.kind === "HOUSEHOLD" ? (opts.householdId ?? null) : null;
  if (opts.kind === "HOUSEHOLD" && !householdId) {
    throw new Error("a household invitation needs a household");
  }

  const token = generateToken();
  const tokenHash = await hashToken(token);

  const invitation = await prisma.$transaction(async (tx) => {
    await tx.invitation.updateMany({
      where: { email, householdId, acceptedAt: null, revokedAt: null },
      data: { revokedAt: now },
    });

    return tx.invitation.create({
      data: {
        tokenHash,
        email,
        invitedName: opts.invitedName?.trim() || null,
        kind: opts.kind,
        householdId,
        householdName: opts.householdName?.trim() || null,
        invitedById: opts.invitedById,
        expiresAt: new Date(now.getTime() + INVITATION_TTL_MS),
      },
    });
  });

  return { invitation, token };
}

/** Withdraw a live invitation. Returns false if it was already spent or gone. */
export async function revokeInvitation(opts: {
  id: string;
  /** Scopes the revocation to one household's own invitations. */
  householdId?: string | null;
  now?: Date;
}): Promise<boolean> {
  const revoked = await prisma.invitation.updateMany({
    where: {
      id: opts.id,
      ...(opts.householdId === undefined ? {} : { householdId: opts.householdId }),
      acceptedAt: null,
      revokedAt: null,
    },
    data: { revokedAt: opts.now ?? new Date() },
  });
  return revoked.count === 1;
}

/** What a roster screen shows next to the members: who is still expected. */
export interface PendingInvitation {
  id: string;
  email: string;
  invitedName: string | null;
  kind: InvitationKind;
  /// The name suggested for the household a PLATFORM invitation will create.
  /// Always null for a household invitation, which joins one that exists.
  householdName: string | null;
  invitedBy: string | null;
  expiresAt: Date;
  createdAt: Date;
}

/**
 * The invitations a household is still waiting on.
 *
 * Expired ones are included and dated rather than hidden: an admin who invited
 * somebody nine days ago needs to see that the link lapsed, which is the whole
 * explanation for why nobody arrived. Revoked and accepted rows are not listed
 * — they are history, and history belongs in the audit trail (Phase 6), not in
 * a list of people you are expecting.
 */
export async function listPendingInvitations(
  householdId: string | null,
): Promise<PendingInvitation[]> {
  const rows = await prisma.invitation.findMany({
    where: { householdId, acceptedAt: null, revokedAt: null },
    orderBy: { createdAt: "desc" },
    include: { invitedBy: { select: { name: true, email: true } } },
  });

  return rows.map((row) => ({
    id: row.id,
    email: row.email,
    invitedName: row.invitedName,
    kind: row.kind,
    householdName: row.householdName,
    invitedBy: row.invitedBy ? (row.invitedBy.name ?? row.invitedBy.email) : null,
    expiresAt: row.expiresAt,
    createdAt: row.createdAt,
  }));
}

/** Whether this address is already in this household — asked before inviting. */
export async function isAlreadyMember(email: string, householdId: string): Promise<boolean> {
  const found = await prisma.householdMembership.findFirst({
    where: { householdId, user: { email: normalizeEmail(email) } },
    select: { userId: true },
  });
  return found !== null;
}

// -----------------------------------------------------------------------------
// Delivery
// -----------------------------------------------------------------------------

/**
 * The address the invitee opens.
 *
 * APP_URL first, so a household that has published a name for the box hands
 * out that name whether or not the link happens to be travelling by email.
 * Without APP_URL we fall back to the origin the inviting request arrived on:
 * it came from a member's browser, and every member reaches the box by the
 * same MagicDNS name on the tailnet (§10). That fallback can read as loopback
 * behind a proxy, but it is only ever shown to a person who can see the host
 * is wrong and fix it — never mailed.
 */
export function invitationUrl(token: string, fallbackOrigin?: string): string {
  const path = invitationPath(token);
  try {
    return appUrl(path);
  } catch {
    if (!fallbackOrigin) throw new Error("no APP_URL and no fallback origin");
    return new URL(path, fallbackOrigin).toString();
  }
}

/**
 * Mail the link, or say that there was nothing to mail it with.
 *
 * An instance with no SMTP server still invites: the mail is how the link
 * usually travels, not what makes it valid. When there is nothing to send
 * with, the caller hands the link to the inviter to pass on themselves — which
 * is the difference between a household that hasn't wired up SMTP being able
 * to add the person they share a kitchen with, and not.
 *
 * A relay that is configured and *refuses* is a different thing entirely, and
 * throws: that is a fault to repair, not a reason to start passing seven-day
 * credentials around by hand.
 */
export async function sendInvitationMail(opts: {
  invitation: Pick<Invitation, "email" | "invitedName" | "kind" | "householdName">;
  token: string;
  invitedBy: string;
  /** The household being joined; null for a platform invitation. */
  householdName: string | null;
}): Promise<boolean> {
  if (!isMailConfigured()) return false;

  const mail =
    opts.invitation.kind === "HOUSEHOLD"
      ? householdInviteEmail({
          name: opts.invitation.invitedName,
          token: opts.token,
          invitedBy: opts.invitedBy,
          householdName: opts.householdName ?? "a MealPlanner household",
        })
      : platformInviteEmail({
          name: opts.invitation.invitedName,
          token: opts.token,
          invitedBy: opts.invitedBy,
          householdName: opts.invitation.householdName,
        });

  try {
    await sendMail({ to: opts.invitation.email, ...mail });
    return true;
  } catch (err) {
    // A configuration that vanished between the check and the send (an empty
    // APP_URL, say) is the no-mail case arriving late, not a delivery failure.
    if (err instanceof MailNotConfiguredError) return false;
    throw err;
  }
}

// -----------------------------------------------------------------------------
// Acceptance
// -----------------------------------------------------------------------------

/** Everything the acceptance page needs to word itself, before anything is spent. */
export interface InvitationView {
  state: ReturnType<typeof invitationState>;
  email: string;
  invitedName: string | null;
  kind: InvitationKind;
  /** The household being joined, or the name suggested for the one to create. */
  householdName: string | null;
  invitedBy: string | null;
  plan: AcceptancePlan;
  askForPassword: boolean;
  askForHouseholdName: boolean;
}

/**
 * Look an invitation up without spending it.
 *
 * The page renders from this, so a dead link says so before anybody types a
 * password, and a link belonging to an address that already has an account
 * doesn't show a password field it will then ignore.
 */
export async function inspectInvitation(
  rawToken: string,
  now: Date = new Date(),
): Promise<InvitationView | null> {
  const invitation = await prisma.invitation.findUnique({
    where: { tokenHash: await hashToken(rawToken) },
    include: {
      household: { select: { name: true } },
      invitedBy: { select: { name: true, email: true } },
    },
  });
  if (!invitation) return null;

  const existing = await prisma.user.findUnique({
    where: { email: invitation.email },
    select: { id: true, passwordHash: true },
  });

  const alreadyMember =
    existing !== null && invitation.householdId !== null
      ? (await prisma.householdMembership.findUnique({
          where: {
            householdId_userId: {
              householdId: invitation.householdId,
              userId: existing.id,
            },
          },
          select: { userId: true },
        })) !== null
      : false;

  const plan = acceptancePlan({
    existingUser: existing ? { hasPassword: existing.passwordHash !== null } : null,
    alreadyMember,
  });

  return {
    state: invitationState(invitation, now),
    email: invitation.email,
    invitedName: invitation.invitedName,
    kind: invitation.kind,
    householdName: invitation.household?.name ?? invitation.householdName,
    invitedBy: invitation.invitedBy
      ? (invitation.invitedBy.name ?? invitation.invitedBy.email)
      : null,
    plan,
    askForPassword: needsPassword(plan),
    askForHouseholdName: needsHouseholdName(invitation, plan),
  };
}

export type AcceptFailure =
  | AcceptanceRefusal
  | "invalid-token"
  | "password-required"
  | "household-name-required";

export type AcceptResult =
  | { ok: true; userId: string; householdId: string; plan: AcceptancePlan }
  | { ok: false; error: AcceptFailure };

/**
 * The sentence recorded when a link is spent (§9c, Phase 6).
 *
 * A pure function of the outcome, kept separate from acceptInvitation for the
 * reason invitations.ts is separate from this file: the wording has three
 * genuinely different shapes — a new household created, an existing one
 * joined, or a link reopened on a membership that was already there — and a
 * table of examples is what src/lib/invitationService.test.mjs checks against
 * without a database.
 */
export function acceptanceDetail(opts: {
  email: string;
  householdName: string;
  householdCreated: boolean;
  plan: AcceptancePlan;
}): string {
  if (opts.plan === "already-a-member") {
    return `${opts.email} reopened an invitation to ${opts.householdName}, which they already belonged to.`;
  }
  if (opts.householdCreated) {
    return `${opts.email} accepted an invitation and created ${opts.householdName}.`;
  }
  return `${opts.email} accepted an invitation and joined ${opts.householdName} as an admin.`;
}

/**
 * The sentence recorded when accepting actually seats somebody at the table —
 * every case above except `already-a-member`, where the membership already
 * existed and nothing new came into being.
 */
export function membershipJoinedDetail(opts: {
  email: string;
  householdName: string;
  householdCreated: boolean;
}): string {
  return opts.householdCreated
    ? `${opts.email} became the first admin of ${opts.householdName}.`
    : `${opts.email} joined ${opts.householdName} as an admin, via invitation.`;
}

/** Thrown inside the transaction to roll it back when the claim is lost. */
class LostClaimError extends Error {}

/**
 * Spend an invitation: create or link the account, join the household, and
 * mark the row accepted — all of it, or none of it.
 *
 * The claim is an `updateMany` filtered on `acceptedAt: null`, the same trick
 * AuthToken uses, and it runs *first*. Two tabs submitting the same link at the
 * same moment therefore produce one winner and one `accepted`, rather than two
 * memberships or — worse, on a PLATFORM invitation — two households, one of
 * which nobody would ever see again.
 *
 * `signedInEmail` is how a session takes part in the email binding. Somebody
 * signed in as one account who opens an invitation addressed to another is not
 * quietly given the second household under the first account; they are told the
 * link is for a different address, and can sign out and try again.
 */
export async function acceptInvitation(opts: {
  token: string;
  /** The signed-in account's address, if the visitor has a session. */
  signedInEmail?: string | null;
  /** Already hashed, because scrypt has no business inside a transaction. */
  passwordHash?: string | null;
  name?: string | null;
  householdName?: string | null;
  now?: Date;
}): Promise<AcceptResult> {
  const now = opts.now ?? new Date();

  const invitation = await prisma.invitation.findUnique({
    where: { tokenHash: await hashToken(opts.token) },
    include: { household: { select: { name: true } } },
  });
  if (!invitation) return { ok: false, error: "invalid-token" };

  const presented = opts.signedInEmail ? normalizeEmail(opts.signedInEmail) : invitation.email;
  const refusal = acceptanceRefusal(invitation, presented, now);
  if (refusal) return { ok: false, error: refusal };

  const existing = await prisma.user.findUnique({
    where: { email: invitation.email },
    select: { id: true, passwordHash: true },
  });

  const alreadyMember =
    existing !== null && invitation.householdId !== null
      ? (await prisma.householdMembership.findUnique({
          where: {
            householdId_userId: {
              householdId: invitation.householdId,
              userId: existing.id,
            },
          },
          select: { userId: true },
        })) !== null
      : false;

  const plan = acceptancePlan({
    existingUser: existing ? { hasPassword: existing.passwordHash !== null } : null,
    alreadyMember,
  });

  if (needsPassword(plan) && !opts.passwordHash) {
    return { ok: false, error: "password-required" };
  }

  const newHouseholdName =
    opts.householdName?.trim() || invitation.householdName?.trim() || null;
  if (needsHouseholdName(invitation, plan) && !newHouseholdName) {
    return { ok: false, error: "household-name-required" };
  }

  try {
    const result = await prisma.$transaction(async (tx) => {
      // Claim first. Everything below is only worth doing for the winner.
      const claimed = await tx.invitation.updateMany({
        where: {
          id: invitation.id,
          acceptedAt: null,
          revokedAt: null,
          expiresAt: { gt: now },
        },
        data: { acceptedAt: now },
      });
      if (claimed.count !== 1) throw new LostClaimError();

      const user =
        existing !== null
          ? await tx.user.update({
              where: { id: existing.id },
              data: {
                // An existing account's profile is not the invitation's to
                // rewrite; the one thing that may be filled in is a password
                // that was never set, which is how a half-finished invitation
                // from the old scheme completes.
                ...(opts.passwordHash && existing.passwordHash === null
                  ? { passwordHash: opts.passwordHash }
                  : {}),
              },
            })
          : await tx.user.create({
              data: {
                email: invitation.email,
                name: opts.name?.trim() || invitation.invitedName || null,
                passwordHash: opts.passwordHash ?? null,
              },
            });

      const householdId =
        invitation.householdId ??
        (
          await tx.household.create({
            data: {
              name: newHouseholdName ?? "Household",
              settings: { create: {} },
            },
          })
        ).id;

      await tx.householdMembership.upsert({
        where: { householdId_userId: { householdId, userId: user.id } },
        update: {},
        create: { householdId, userId: user.id, role: INVITED_ROLE },
      });

      // Recording the household on a PLATFORM row is what makes "which
      // household did this invitation create?" answerable later; the check
      // constraint permits it only once the row is spent.
      await tx.invitation.update({
        where: { id: invitation.id },
        data: { acceptedById: user.id, householdId },
      });

      // Any other live link to the same address and household is now moot.
      await tx.invitation.updateMany({
        where: {
          email: invitation.email,
          householdId,
          id: { not: invitation.id },
          acceptedAt: null,
          revokedAt: null,
        },
        data: { revokedAt: now },
      });

      return { userId: user.id, householdId };
    });

    // Acceptance is unauthenticated by nature — a link is the credential, not a
    // session — so there is no actor to name; the record leans on the address
    // the invitation was bound to and the sentence itself. Two rows, not one:
    // INVITATION_ACCEPTED closes the invitation's own story (it fires even for
    // `already-a-member`, where a link was reopened but nothing new was
    // seated), and HOUSEHOLD_MEMBER_JOINED is the mirror of
    // HOUSEHOLD_MEMBER_REMOVED — a roster line, written only when one actually
    // appeared. Awaited, not fired-and-forgotten: recordAudit already swallows
    // its own errors, so awaiting costs nothing and losing the promise would
    // risk an unhandled rejection if that ever changed.
    const householdCreated = invitation.householdId === null;
    const householdName = invitation.household?.name ?? newHouseholdName ?? "Household";

    await recordAudit({
      action: "INVITATION_ACCEPTED",
      subjectEmail: invitation.email,
      household: { id: result.householdId, name: householdName },
      detail: acceptanceDetail({
        email: invitation.email,
        householdName,
        householdCreated,
        plan,
      }),
    });

    if (plan !== "already-a-member") {
      await recordAudit({
        action: "HOUSEHOLD_MEMBER_JOINED",
        subjectEmail: invitation.email,
        household: { id: result.householdId, name: householdName },
        detail: membershipJoinedDetail({ email: invitation.email, householdName, householdCreated }),
      });
    }

    return { ok: true, plan, ...result };
  } catch (error) {
    if (error instanceof LostClaimError) return { ok: false, error: "accepted" };
    // A concurrent acceptance that got as far as creating the same account.
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2002"
    ) {
      return { ok: false, error: "accepted" };
    }
    throw error;
  }
}
