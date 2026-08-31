/**
 * Who may operate the installation, and what operating it does *not* include
 * (§9, §9c).
 *
 * Pure, and separate from the routes that call it, for the reason
 * src/lib/invitations.ts is separate: an authorization rule that can only be
 * exercised by standing up a server and holding four different cookies is a
 * rule nobody tests exhaustively. These take the caller as an argument and
 * answer in microseconds, so the whole matrix — anonymous, household member,
 * household admin, platform admin — is checked for every operation on every
 * `npm test`.
 */

import type { HouseholdRole, PlatformRole } from "@prisma/client";

/** Everything an authorization decision here is allowed to look at. */
export interface Caller {
  /** Null for an anonymous request. */
  platformRole: PlatformRole | null;
  /**
   * Whether a valid shared secret was presented instead of a session — the
   * `Authorization: Bearer …` a cron job or a host script carries, since it
   * has no cookie jar (see bearerTokenMatches in src/lib/auth.ts).
   */
  bearer?: boolean;
}

export type AccessDecision = "allow" | "unauthorized" | "forbidden";

/**
 * Whether this caller may drive an installation-wide operation: the SMTP
 * diagnostics, the backup repository, anything whose blast radius is the box
 * rather than one kitchen.
 *
 * The distinction between `unauthorized` and `forbidden` is kept because they
 * are different facts and the interface reacts differently to each: a 401 says
 * "sign in", a 403 says "signed in, and still no". Collapsing them would send
 * a signed-in member who found the URL back to a login form that cannot
 * possibly help.
 *
 * Until now every one of these endpoints accepted any signed-in account. On a
 * single-household box behind Tailscale that was nearly true; the moment a
 * second household exists, "anybody with a login" includes people from a
 * different kitchen entirely, and the backup passphrase is not theirs to read.
 */
export function operationalAccess(caller: Caller): AccessDecision {
  if (caller.bearer) return "allow";
  if (caller.platformRole === null) return "unauthorized";
  return caller.platformRole === "ADMIN" ? "allow" : "forbidden";
}

/**
 * Whether this caller may use the platform-admin screens at all.
 *
 * The same rule without the bearer door: a shared secret is for a script
 * driving one known operation, never for browsing households.
 */
export function platformScreenAccess(caller: Caller): AccessDecision {
  return operationalAccess({ platformRole: caller.platformRole });
}

/** Why an intervention is refused, or null when it is allowed. */
export type InterventionRefusal = "not-platform-admin" | "not-a-member" | "last-admin";

/**
 * Whether a platform admin may change somebody's role inside a household.
 *
 * This is the escape hatch for the rule that household admins are equals and
 * cannot demote one another (memberRemovalRefusal in src/lib/invitations.ts).
 * That rule is right — two people who share a kitchen should not be able to
 * race each other out of it — but it leaves a household that has genuinely
 * fallen out with no way forward, and a household whose only admin has lost
 * their mailbox with no way back in. Somebody outside has to be able to act.
 *
 * `last-admin` is the one thing even a platform admin is not allowed to do
 * through this screen: demoting the last remaining admin would leave a
 * household nobody can administer, which is the very state this exists to
 * repair. Removing that person is still possible — that is a household being
 * wound down, and it is a different button with a different record.
 */
export function roleInterventionRefusal(opts: {
  caller: Caller;
  /** The membership being changed, or null if the user is not in it. */
  target: { role: HouseholdRole } | null;
  nextRole: HouseholdRole;
  /** How many admins the household has right now, including the target. */
  adminCount: number;
}): InterventionRefusal | null {
  if (opts.caller.platformRole !== "ADMIN") return "not-platform-admin";
  if (!opts.target) return "not-a-member";
  if (
    opts.target.role === "ADMIN" &&
    opts.nextRole === "MEMBER" &&
    opts.adminCount <= 1
  ) {
    return "last-admin";
  }
  return null;
}

/**
 * Whether a platform admin may remove somebody from a household.
 *
 * Unlike the role change there is no last-admin guard, and that is deliberate:
 * removing the final member is how a household is wound up, and refusing it
 * would leave abandoned households on the box for ever with no way to clear
 * them. What it costs is a row in the audit trail saying who did it.
 */
export function removalInterventionRefusal(opts: {
  caller: Caller;
  target: { role: HouseholdRole } | null;
}): InterventionRefusal | null {
  if (opts.caller.platformRole !== "ADMIN") return "not-platform-admin";
  if (!opts.target) return "not-a-member";
  return null;
}

/**
 * Whether a platform role may be changed through the ordinary interface.
 *
 * Nothing calls this yet, and that is the honest state of things: promotion to
 * platform admin is not offered anywhere, so there is no screen for this rule
 * to guard. It is written down because the plan asks what would happen if
 * promotion were added, and the answer is easier to get right here, once, than
 * in the pull request that adds the button: a platform admin may not demote
 * themselves — locking the last operator out of their own installation — and
 * may not demote a peer, for the same reason household admins cannot.
 */
export function platformRoleChangeRefusal(opts: {
  caller: Caller & { userId: string };
  target: { userId: string; platformRole: PlatformRole };
  nextRole: PlatformRole;
}): "not-platform-admin" | "self" | "peer-platform-admin" | null {
  if (opts.caller.platformRole !== "ADMIN") return "not-platform-admin";
  if (opts.nextRole === "ADMIN") return null;
  if (opts.target.userId === opts.caller.userId) return "self";
  if (opts.target.platformRole === "ADMIN") return "peer-platform-admin";
  return null;
}
