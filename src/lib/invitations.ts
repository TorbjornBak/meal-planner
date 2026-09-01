/**
 * What an invitation *means* — the decisions, with no database attached (§9).
 *
 * Split from src/lib/invitationService.ts for the reason src/lib/newsletter.ts
 * is split from src/lib/weeklyDigest.ts: the rules about who may accept what,
 * and who an admin may remove, are the part worth testing exhaustively, and
 * they test in milliseconds when they take rows as arguments instead of
 * fetching them. Everything here is a total function of its inputs.
 */

import type { HouseholdRole, InvitationKind } from "@prisma/client";

/**
 * Seven days, as the plan promises in the mail.
 *
 * Long enough to survive a holiday and a full inbox; short enough that a link
 * lying in a mail archive a year from now is not a way into a household. The
 * password reset window (one hour) is far shorter because a reset answers a
 * request someone just made, while an invitation waits for a stranger.
 */
export const INVITATION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** Just the invitation fields any decision here depends on. */
export interface InvitationFacts {
  email: string;
  kind: InvitationKind;
  householdId: string | null;
  expiresAt: Date;
  acceptedAt: Date | null;
  revokedAt: Date | null;
}

/**
 * The four states an invitation can be in, in the order they are checked.
 *
 * Order matters for what the invitee is told. A link that was revoked *and*
 * has since expired should say it was withdrawn, because that is the fact the
 * person needs — "ask them again" rather than "it timed out". Likewise an
 * accepted link reports as accepted forever, so opening it a second time from
 * a mail client explains itself instead of looking broken.
 */
export type InvitationState = "revoked" | "accepted" | "expired" | "live";

export function invitationState(inv: InvitationFacts, now: Date = new Date()): InvitationState {
  if (inv.revokedAt) return "revoked";
  if (inv.acceptedAt) return "accepted";
  if (inv.expiresAt.getTime() <= now.getTime()) return "expired";
  return "live";
}

/** Why an invitation cannot be accepted, or null when it can. */
export type AcceptanceRefusal =
  | "revoked"
  | "accepted"
  | "expired"
  | "email-mismatch"
  | "sign-in-required";

/**
 * Whether this visitor, in this session state, may spend this link.
 *
 * `signedInEmail` is the visitor's own session address, already normalized,
 * or null when they have no session at all — never defaulted to the
 * invitation's own address by a caller trying to make an anonymous visitor
 * "pass" the check. Doing that once, silently, is the difference between an
 * invitation that proves control of a mailbox and one that IS a bearer
 * credential for whoever holds the link; see acceptInvitation's own comment
 * on `sign-in-required` for the account-takeover that gap used to open.
 *
 * Two checks, in order:
 *
 * - A signed-in visitor at a different address never gets past a live
 *   invitation, whatever it would resolve to: `email-mismatch`. A forwarded
 *   link, or one lifted from a mail archive by somebody who then opens it
 *   signed in as themselves, gets this and nothing else.
 * - A visitor with no session at all is let through only when `plan` is
 *   `create-account` — nobody holds the address yet, so there is no existing
 *   account for a session to prove control of, and the token really is the
 *   only credential there is meant to be. For `link-account` and
 *   `already-a-member`, an account already exists at the address, and
 *   `sign-in-required` is what stands between an anonymous caller and
 *   minting a session for it.
 *
 * Note what is *not* checked here: whether the invitation's address is worth
 * asking for a password. That is `needsPassword`'s job, on the plan alone —
 * conflating the two is how an existing user ends up being asked for a new
 * one.
 */
export function acceptanceRefusal(
  inv: InvitationFacts,
  opts: { signedInEmail: string | null; plan: AcceptancePlan },
  now: Date = new Date(),
): AcceptanceRefusal | null {
  const state = invitationState(inv, now);
  if (state !== "live") return state;
  if (opts.signedInEmail !== null) {
    return opts.signedInEmail === inv.email ? null : "email-mismatch";
  }
  return planRequiresSignIn(opts.plan) ? "sign-in-required" : null;
}

/**
 * What accepting will actually do, given who already exists.
 *
 * Three shapes, and the middle one is the one the old flow could not express:
 *
 * - `create-account`   nobody holds the address; they choose a password and the
 *                      account, membership (and for a PLATFORM invitation, the
 *                      household) are created together.
 * - `link-account`     the address already signs in here. Their password is not
 *                      touched and not asked for: they proved control of the
 *                      mailbox by opening the link, which is precisely what a
 *                      reset link proves, and asking a person to reset a working
 *                      password in order to join a second household is how you
 *                      teach them that a mailed link means "type your password".
 * - `already-a-member` the invitation points at a household they are already in.
 *                      Not an error — a duplicate invitation, or a second click
 *                      on the same link after the first succeeded — so the row
 *                      is spent and they are simply sent inside.
 */
export type AcceptancePlan = "create-account" | "link-account" | "already-a-member";

export function acceptancePlan(opts: {
  /** The account at the invitation's address, if any. */
  existingUser: { hasPassword: boolean } | null;
  /** Whether that account is already a member of the invitation's household. */
  alreadyMember: boolean;
}): AcceptancePlan {
  if (!opts.existingUser) return "create-account";
  if (opts.alreadyMember) return "already-a-member";
  // Invited before this table existed, or invited and never finished: the row
  // exists but cannot sign in, so a password is still needed.
  return opts.existingUser.hasPassword ? "link-account" : "create-account";
}

/** Whether the acceptance form has to ask for a password at all. */
export function needsPassword(plan: AcceptancePlan): boolean {
  return plan === "create-account";
}

/**
 * Whether spending this plan requires the visitor to already be signed in
 * as the invitation's own address.
 *
 * True for both plans that resolve to an account that already exists.
 * `link-account` is the obvious one; `already-a-member` is easy to miss,
 * because spending it looks like a no-op — the membership is already
 * there — but acceptInvitation still looks the account up, still signs the
 * caller in as it, and still hands back a session at the end. An anonymous
 * caller who merely holds the link is therefore just as able to mint a
 * session for somebody else's account through `already-a-member` as through
 * `link-account`; the fact that the household part is a no-op doesn't make
 * the account part one. `create-account` is the one plan this excludes:
 * nobody holds the address yet, so there is no existing account for a
 * session to prove control of, and the token is genuinely the only
 * credential there is meant to be.
 */
export function planRequiresSignIn(plan: AcceptancePlan): boolean {
  return plan !== "create-account";
}

/** Whether the acceptance form has to ask what the new household is called. */
export function needsHouseholdName(inv: { kind: InvitationKind }, plan: AcceptancePlan): boolean {
  return inv.kind === "PLATFORM" && plan !== "already-a-member";
}

/**
 * The role an accepted invitation grants.
 *
 * Both kinds grant ADMIN, for the same reason from two directions: a household
 * invitation is one kitchen asking another adult to help run it, and a platform
 * invitation creates a household that would otherwise have nobody who could
 * invite anyone. A plain MEMBER role exists in the schema and is what a
 * household admin can demote *to* later; it is not what an invitation hands out.
 */
export const INVITED_ROLE: HouseholdRole = "ADMIN";

// -----------------------------------------------------------------------------
// Household administration
// -----------------------------------------------------------------------------

/** Why a roster change is refused, or null when it is allowed. */
export type MemberChangeRefusal = "not-admin" | "peer-admin" | "self" | "not-a-member";

/**
 * Whether an admin may remove somebody from their household.
 *
 * The rule that matters is `peer-admin`: admins are equals, and an equal who
 * can delete an equal means the household's data belongs to whoever clicks
 * first. Two people who share a kitchen and have fallen out should end up
 * talking to each other, or to a platform admin (Phase 5), rather than racing.
 *
 * Removing yourself is refused here too, though for a duller reason: it is
 * leaving, not administering, and it has a different confirmation, a different
 * warning about the last admin, and a different place in the interface. Wiring
 * it into the remove button would give it none of those.
 */
export function memberRemovalRefusal(opts: {
  actor: { userId: string; role: HouseholdRole };
  target: { userId: string; role: HouseholdRole } | null;
}): MemberChangeRefusal | null {
  if (opts.actor.role !== "ADMIN") return "not-admin";
  if (!opts.target) return "not-a-member";
  if (opts.target.userId === opts.actor.userId) return "self";
  if (opts.target.role === "ADMIN") return "peer-admin";
  return null;
}

/**
 * Whether an admin may change somebody's role.
 *
 * Same peer rule, and it is the demotion half that makes it necessary: without
 * it, "you may not remove another admin" is a speed bump you get past by
 * demoting them first and removing them second.
 */
export function roleChangeRefusal(opts: {
  actor: { userId: string; role: HouseholdRole };
  target: { userId: string; role: HouseholdRole } | null;
}): MemberChangeRefusal | null {
  return memberRemovalRefusal(opts);
}

// -----------------------------------------------------------------------------
// Links
// -----------------------------------------------------------------------------

/**
 * Where an invitation is accepted.
 *
 * Its own path rather than /reset/<token>, which invitations used to share.
 * The two pages now say genuinely different things — one of them may not ask
 * for a password at all, and may ask what to call a household — and a shared
 * path meant every visit guessed which by trying both token tables in turn.
 */
export function invitationPath(token: string): string {
  return `/invite/${token}`;
}
