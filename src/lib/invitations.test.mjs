// Tests for the invitation rules (§9). Run with `npm test`.
//
// Everything in src/lib/invitations.ts is a total function of the arguments it
// is given, which is the whole reason it was split out of invitationService.ts:
// the questions worth testing exhaustively — which state an invitation is in,
// whether a given person may spend it, what accepting will actually do, and
// who an admin may touch on the roster — take rows as plain objects here
// rather than fetching them, so the exhaustive table is cheap to write and
// instant to run. The database-backed half of the same behaviour is covered
// in src/lib/invitations.integration.test.mjs.

import test from "node:test";
import assert from "node:assert/strict";

import {
  INVITATION_TTL_MS,
  INVITED_ROLE,
  acceptancePlan,
  acceptanceRefusal,
  invitationPath,
  invitationState,
  memberRemovalRefusal,
  needsHouseholdName,
  needsPassword,
  planRequiresSignIn,
  roleChangeRefusal,
} from "./invitations.ts";

const NOW = new Date("2026-08-31T12:00:00.000Z");

/** A live household invitation, with the boring fields filled in. */
function invitation(over = {}) {
  return {
    email: "invitee@example.test",
    kind: "HOUSEHOLD",
    householdId: "household-1",
    expiresAt: new Date(NOW.getTime() + 60_000),
    acceptedAt: null,
    revokedAt: null,
    ...over,
  };
}

// --- invitationState ---------------------------------------------------------

test("an invitation with no dates set and time left on the clock is live", () => {
  assert.equal(invitationState(invitation(), NOW), "live");
});

test("an invitation expires the instant its expiry time is reached, not just after", () => {
  // The boundary itself, not a moment either side of it: expiresAt === now must
  // already read as expired, because the transactional claim in
  // invitationService.ts checks `expiresAt: { gt: now }` — anything this
  // function called "live" at the boundary would be a link the claim then
  // refused, which is a worse bug than either side landing wrong on its own.
  const inv = invitation({ expiresAt: NOW });
  assert.equal(invitationState(inv, NOW), "expired");
});

test("a moment before its expiry an invitation is still live", () => {
  const inv = invitation({ expiresAt: new Date(NOW.getTime() + 1) });
  assert.equal(invitationState(inv, NOW), "live");
});

test("a moment after its expiry an invitation reads as expired", () => {
  const inv = invitation({ expiresAt: new Date(NOW.getTime() - 1) });
  assert.equal(invitationState(inv, NOW), "expired");
});

test("an accepted invitation reads as accepted, whether or not it has since expired", () => {
  assert.equal(
    invitationState(invitation({ acceptedAt: new Date(NOW.getTime() - 1000) }), NOW),
    "accepted",
  );
  // Accepted years ago and long past its expiry: still accepted, not expired.
  // A link that already worked once must always explain itself as "already
  // used", not "too late" — the second reading suggests trying again sooner.
  assert.equal(
    invitationState(
      invitation({
        acceptedAt: new Date(NOW.getTime() - 1000),
        expiresAt: new Date(NOW.getTime() - 999_999),
      }),
      NOW,
    ),
    "accepted",
  );
});

test("a revoked invitation reads as revoked, even one that was also accepted or has expired", () => {
  assert.equal(invitationState(invitation({ revokedAt: new Date(NOW.getTime() - 1000) }), NOW), "revoked");
  // The full house: revoked, accepted and expired all at once. Revoked wins,
  // per the ordering the module documents — a withdrawn invitation should
  // never be explained to anyone as merely late or merely used.
  assert.equal(
    invitationState(
      invitation({
        revokedAt: new Date(NOW.getTime() - 500),
        acceptedAt: new Date(NOW.getTime() - 1000),
        expiresAt: new Date(NOW.getTime() - 999_999),
      }),
      NOW,
    ),
    "revoked",
  );
});

test("invitationState defaults to judging against the current moment", () => {
  assert.equal(invitationState(invitation({ expiresAt: new Date(Date.now() + 60_000) })), "live");
  assert.equal(invitationState(invitation({ expiresAt: new Date(Date.now() - 60_000) })), "expired");
});

// --- acceptanceRefusal --------------------------------------------------------
//
// signedInEmail is the visitor's own session address (already normalized) or
// null for no session at all — never defaulted to the invitation's address.
// That default is exactly the bug this rule closes: see the module comment.

test("a revoked invitation is refused as revoked, regardless of who is signed in or what plan applies", () => {
  const inv = invitation({ revokedAt: new Date(NOW.getTime() - 1000) });
  assert.equal(acceptanceRefusal(inv, { signedInEmail: inv.email, plan: "create-account" }, NOW), "revoked");
  // Even the matching address, and even a plan that would otherwise be let
  // through anonymously, doesn't get past a revocation.
  assert.equal(acceptanceRefusal(inv, { signedInEmail: null, plan: "create-account" }, NOW), "revoked");
  assert.equal(
    acceptanceRefusal(inv, { signedInEmail: "someone.else@example.test", plan: "link-account" }, NOW),
    "revoked",
  );
});

test("an accepted invitation is refused as accepted, regardless of session or plan", () => {
  const inv = invitation({ acceptedAt: new Date(NOW.getTime() - 1000) });
  assert.equal(acceptanceRefusal(inv, { signedInEmail: inv.email, plan: "create-account" }, NOW), "accepted");
  assert.equal(acceptanceRefusal(inv, { signedInEmail: null, plan: "create-account" }, NOW), "accepted");
});

test("an expired invitation is refused as expired, regardless of session or plan", () => {
  const inv = invitation({ expiresAt: new Date(NOW.getTime() - 1) });
  assert.equal(acceptanceRefusal(inv, { signedInEmail: inv.email, plan: "create-account" }, NOW), "expired");
  assert.equal(acceptanceRefusal(inv, { signedInEmail: null, plan: "create-account" }, NOW), "expired");
});

test("a live invitation, signed in under a different address, is refused as a mismatch — whatever the plan", () => {
  assert.equal(
    acceptanceRefusal(invitation(), { signedInEmail: "someone.else@example.test", plan: "create-account" }, NOW),
    "email-mismatch",
  );
  assert.equal(
    acceptanceRefusal(invitation(), { signedInEmail: "someone.else@example.test", plan: "link-account" }, NOW),
    "email-mismatch",
  );
});

test("a live invitation signed in under the exact address it names is allowed, for every plan", () => {
  assert.equal(acceptanceRefusal(invitation(), { signedInEmail: "invitee@example.test", plan: "create-account" }, NOW), null);
  assert.equal(acceptanceRefusal(invitation(), { signedInEmail: "invitee@example.test", plan: "link-account" }, NOW), null);
  assert.equal(acceptanceRefusal(invitation(), { signedInEmail: "invitee@example.test", plan: "already-a-member" }, NOW), null);
});

test("the email check is exact — it neither case-folds nor trims", () => {
  // Normalisation is normalizeEmail's job (src/lib/auth.ts), applied once
  // before either side of this comparison is formed. Doing it again here would
  // hide a caller that forgot to normalise behind a check that happens to work
  // anyway, right up until it meets an address this function's idea of
  // case-folding disagrees with.
  const inv = invitation({ email: "invitee@example.test" });
  assert.equal(acceptanceRefusal(inv, { signedInEmail: "Invitee@Example.Test", plan: "create-account" }, NOW), "email-mismatch");
  assert.equal(acceptanceRefusal(inv, { signedInEmail: "invitee@example.test ", plan: "create-account" }, NOW), "email-mismatch");
  assert.equal(acceptanceRefusal(inv, { signedInEmail: " invitee@example.test", plan: "create-account" }, NOW), "email-mismatch");
});

// --- planRequiresSignIn / the anonymous-takeover fix --------------------------
//
// This is the rule that closes the vulnerability: an invitation token must
// never, by itself, be enough to mint a session for an account that already
// exists. Before this fix, acceptInvitation defaulted a missing
// signedInEmail to the invitation's own address, which made the email check
// above vacuous for an anonymous caller — the token alone satisfied it every
// time. These cases are the ones that mattered in practice.

test("only create-account can be spent anonymously", () => {
  assert.equal(planRequiresSignIn("create-account"), false);
  assert.equal(planRequiresSignIn("link-account"), true);
  assert.equal(planRequiresSignIn("already-a-member"), true);
});

test("link-account with no session at all is refused — the account-takeover case", () => {
  assert.equal(
    acceptanceRefusal(invitation(), { signedInEmail: null, plan: "link-account" }, NOW),
    "sign-in-required",
  );
});

test("link-account with a session matching the invitation's own address is allowed", () => {
  assert.equal(
    acceptanceRefusal(invitation(), { signedInEmail: "invitee@example.test", plan: "link-account" }, NOW),
    null,
  );
});

test("link-account with a session for a different address is refused as a mismatch, not sign-in-required", () => {
  // The visitor does have a session — it's simply the wrong one. Reporting
  // that as "you're not signed in" would be actively misleading, since they
  // are; email-mismatch is the accurate word for what's wrong.
  assert.equal(
    acceptanceRefusal(invitation(), { signedInEmail: "someone.else@example.test", plan: "link-account" }, NOW),
    "email-mismatch",
  );
});

test("create-account with no session is still allowed — a brand new person has no session to hold", () => {
  assert.equal(
    acceptanceRefusal(invitation(), { signedInEmail: null, plan: "create-account" }, NOW),
    null,
  );
});

test("already-a-member with no session is refused exactly like link-account", () => {
  // Easy to assume this one is harmless because the membership already
  // exists and spending the link is a no-op — but acceptInvitation still
  // signs the caller in as the existing account either way, so it is just as
  // capable of handing an anonymous caller somebody else's session.
  assert.equal(
    acceptanceRefusal(invitation(), { signedInEmail: null, plan: "already-a-member" }, NOW),
    "sign-in-required",
  );
});

test("already-a-member with a matching session is allowed", () => {
  assert.equal(
    acceptanceRefusal(invitation(), { signedInEmail: "invitee@example.test", plan: "already-a-member" }, NOW),
    null,
  );
});

// --- acceptancePlan, needsPassword, needsHouseholdName ------------------------
//
// The matrix the module's own comment sets out: {no user, user with a
// password, user without one} against {already a member, not yet a member}.

test("nobody holds the address: always create-account, whether or not 'already a member' is somehow true", () => {
  assert.equal(acceptancePlan({ existingUser: null, alreadyMember: false }), "create-account");
  // alreadyMember without an existingUser cannot happen for real — a
  // membership implies a user — but the function checks existingUser first
  // regardless, so even a caller that got this combination wrong is still
  // told to create an account rather than being sent to "already-a-member"
  // for a user that doesn't exist.
  assert.equal(acceptancePlan({ existingUser: null, alreadyMember: true }), "create-account");
});

test("an account with a password, not yet a member: link-account", () => {
  assert.equal(
    acceptancePlan({ existingUser: { hasPassword: true }, alreadyMember: false }),
    "link-account",
  );
});

test("an account with a password, already a member: already-a-member, not link-account", () => {
  // Membership is checked ahead of password possession, because a duplicate
  // invitation must always resolve to "you're already in", not "sign in
  // again to join a household you're already part of".
  assert.equal(
    acceptancePlan({ existingUser: { hasPassword: true }, alreadyMember: true }),
    "already-a-member",
  );
});

test("an account with no password yet, not a member: create-account", () => {
  // Invited under the old scheme, or invited and never finished: the row
  // exists but cannot sign in, so it is treated as though nobody holds it.
  assert.equal(
    acceptancePlan({ existingUser: { hasPassword: false }, alreadyMember: false }),
    "create-account",
  );
});

test("an account with no password yet, but already a member: already-a-member", () => {
  assert.equal(
    acceptancePlan({ existingUser: { hasPassword: false }, alreadyMember: true }),
    "already-a-member",
  );
});

test("only create-account asks the form for a password", () => {
  assert.equal(needsPassword("create-account"), true);
  assert.equal(needsPassword("link-account"), false);
  assert.equal(needsPassword("already-a-member"), false);
});

test("a household name is asked for on a platform invitation, unless the invitee is already a member", () => {
  assert.equal(needsHouseholdName({ kind: "PLATFORM" }, "create-account"), true);
  assert.equal(needsHouseholdName({ kind: "PLATFORM" }, "link-account"), true);
  assert.equal(needsHouseholdName({ kind: "PLATFORM" }, "already-a-member"), false);
});

test("a household invitation never asks for a household name, whatever the plan", () => {
  assert.equal(needsHouseholdName({ kind: "HOUSEHOLD" }, "create-account"), false);
  assert.equal(needsHouseholdName({ kind: "HOUSEHOLD" }, "link-account"), false);
  assert.equal(needsHouseholdName({ kind: "HOUSEHOLD" }, "already-a-member"), false);
});

test("an accepted invitation always grants ADMIN", () => {
  assert.equal(INVITED_ROLE, "ADMIN");
});

// --- memberRemovalRefusal / roleChangeRefusal ---------------------------------

const ADMIN = "ADMIN";
const MEMBER = "MEMBER";

test("a non-admin may not remove anybody, not even a plain member", () => {
  const refusal = memberRemovalRefusal({
    actor: { userId: "a", role: MEMBER },
    target: { userId: "b", role: MEMBER },
  });
  assert.equal(refusal, "not-admin");
});

test("removing somebody who isn't on the roster is refused as such", () => {
  const refusal = memberRemovalRefusal({
    actor: { userId: "a", role: ADMIN },
    target: null,
  });
  assert.equal(refusal, "not-a-member");
});

test("an admin may not remove themselves through this rule", () => {
  // Leaving is a different action with its own confirmation and its own
  // warning about the last admin — see the module comment — so this rule
  // simply steps aside rather than allowing or half-handling it.
  const refusal = memberRemovalRefusal({
    actor: { userId: "a", role: ADMIN },
    target: { userId: "a", role: ADMIN },
  });
  assert.equal(refusal, "self");
});

test("self beats peer-admin when they are the same fact", () => {
  // An admin's own row is both "the actor" and "an admin", so the two refusals
  // could both apply; `self` is the one reported, because it names what is
  // actually happening.
  const refusal = memberRemovalRefusal({
    actor: { userId: "a", role: ADMIN },
    target: { userId: "a", role: ADMIN },
  });
  assert.equal(refusal, "self");
});

test("an admin may not remove a peer admin", () => {
  const refusal = memberRemovalRefusal({
    actor: { userId: "a", role: ADMIN },
    target: { userId: "b", role: ADMIN },
  });
  assert.equal(refusal, "peer-admin");
});

test("an admin may remove a plain member — the one case this rule allows", () => {
  const refusal = memberRemovalRefusal({
    actor: { userId: "a", role: ADMIN },
    target: { userId: "b", role: MEMBER },
  });
  assert.equal(refusal, null);
});

test("roleChangeRefusal is the same rule as memberRemovalRefusal, not a lookalike", () => {
  // Without this the two could quietly drift — "you may not remove another
  // admin" defeated by demoting them first, changing their role second — so
  // roleChangeRefusal delegates rather than restating the rule.
  const cases = [
    { actor: { userId: "a", role: MEMBER }, target: { userId: "b", role: MEMBER } },
    { actor: { userId: "a", role: ADMIN }, target: null },
    { actor: { userId: "a", role: ADMIN }, target: { userId: "a", role: ADMIN } },
    { actor: { userId: "a", role: ADMIN }, target: { userId: "b", role: ADMIN } },
    { actor: { userId: "a", role: ADMIN }, target: { userId: "b", role: MEMBER } },
  ];
  for (const opts of cases) {
    assert.equal(roleChangeRefusal(opts), memberRemovalRefusal(opts));
  }
});

// --- Constants and links -------------------------------------------------------

test("an invitation lives for exactly seven days", () => {
  assert.equal(INVITATION_TTL_MS, 7 * 24 * 60 * 60 * 1000);
  assert.equal(INVITATION_TTL_MS, 604_800_000);
});

test("the acceptance link is its own path, keyed on the raw token", () => {
  assert.equal(invitationPath("abc123"), "/invite/abc123");
  assert.equal(invitationPath(""), "/invite/");
});
