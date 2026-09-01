// End-to-end tests of accepting, issuing and revoking invitations (§9). Run
// with `npm test`, against a real Postgres.
//
// src/lib/invitations.ts is pure and tested exhaustively in
// src/lib/invitations.test.mjs; this file is the other half — the transaction
// in src/lib/invitationService.ts that claims a link exactly once, and creates
// an account, a household and a membership together or not at all. That claim
// only means anything under real concurrency against a real database, which is
// why "two acceptances race for the same link" is here rather than asserted
// against a mock.
//
// It needs a reachable DATABASE_URL and skips itself without one, so a laptop
// with no Postgres running still gets a green `npm test`. Every test builds
// its own fixtures with unique addresses and cleans them up in `t.after`, so
// the file is safe to run twice in a row against the same database.
//
// A note on how this file gets to call the real service at all: it imports
// src/lib/invitationService.ts, which reaches Prisma, mail and the email
// templates through the `@/` path alias — an alias only Next.js and `tsc`
// know how to resolve, not a bare `node --test`. Rather than re-implement the
// interesting half of invitationService.ts against `@prisma/client` directly
// (which would test a copy of the logic, not the logic), this file registers a
// small module-resolution hook that rewrites `@/x` to the real file at
// `src/x.ts` before importing anything, so every test below calls
// `acceptInvitation` and friends exactly as a route handler does.

import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import path from "node:path";
import { randomUUID } from "node:crypto";

// AUTH_SECRET drives the HMAC that isn't used here directly, but hashToken and
// the session helpers this file's fixtures touch indirectly all assume it's
// set; a developer running just this file against a scratch database
// shouldn't have to know that first.
process.env.AUTH_SECRET ??= "invitations-integration-test-secret-do-not-use-elsewhere";

const SRC = path.resolve(import.meta.dirname, "..");

const resolveAliasHook = `
  import path from "node:path";
  import { pathToFileURL } from "node:url";
  const SRC = ${JSON.stringify(SRC)};
  export async function resolve(specifier, context, nextResolve) {
    if (specifier.startsWith("@/")) {
      const target = pathToFileURL(path.join(SRC, specifier.slice(2) + ".ts")).href;
      return nextResolve(target, context);
    }
    return nextResolve(specifier, context);
  }
`;
register(`data:text/javascript,${encodeURIComponent(resolveAliasHook)}`, import.meta.url);

const { prisma } = await import("@/lib/prisma");
const { acceptInvitation, issueInvitation, revokeInvitation, listPendingInvitations } =
  await import("@/lib/invitationService");
const { hashPassword } = await import("@/lib/password");
const { hashToken } = await import("@/lib/auth");
const { INVITATION_TTL_MS } = await import("./invitations.ts");

/**
 * Whether there is a database to test against, checked once at module load —
 * the same shape as src/lib/borg.integration.test.mjs, so a missing
 * dependency reads the same way everywhere in this test suite.
 */
async function findSkipReason() {
  if (!process.env.DATABASE_URL) return "DATABASE_URL is not set";
  try {
    await Promise.race([
      prisma.$queryRaw`SELECT 1`,
      new Promise((_resolve, reject) => setTimeout(() => reject(new Error("connection timed out")), 5000)),
    ]);
    return false;
  } catch (err) {
    return `no Postgres reachable at DATABASE_URL (${err instanceof Error ? err.message : String(err)})`;
  }
}

const SKIP = await findSkipReason();

// One real password hash, computed once — scrypt costs ~100ms per call by
// design (src/lib/password.ts), and every test that needs "an existing
// account with a password" can safely share the same one, since the tests
// only ever check that it moved or didn't, never what it says.
const PASSWORD_HASH = SKIP ? null : await hashPassword("a perfectly good existing password");

function uniqueEmail(label) {
  return `${label}-${randomUUID()}@invitations.test`;
}

/** A household plus an admin account to invite from, for one test's fixtures. */
async function makeInviter() {
  const household = await prisma.household.create({ data: { name: `Inviter household ${randomUUID()}` } });
  const user = await prisma.user.create({
    data: { email: uniqueEmail("inviter"), name: "Inviter", passwordHash: PASSWORD_HASH },
  });
  await prisma.householdMembership.create({
    data: { householdId: household.id, userId: user.id, role: "ADMIN" },
  });
  return { household, user };
}

/** Delete rows created for a test, tolerant of some already being gone. */
async function cleanup({ invitationIds = [], householdIds = [], userIds = [] } = {}) {
  if (invitationIds.length) {
    await prisma.invitation.deleteMany({ where: { id: { in: invitationIds } } });
  }
  if (householdIds.length) {
    await prisma.household.deleteMany({ where: { id: { in: householdIds } } });
  }
  if (userIds.length) {
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  }
}

// --- Expiry -------------------------------------------------------------------

test(
  "a link opened after its expiry is refused, before anything is created",
  { skip: SKIP },
  async (t) => {
    const inviter = await makeInviter();
    const email = uniqueEmail("expired");
    const { invitation, token } = await issueInvitation({
      email,
      kind: "HOUSEHOLD",
      householdId: inviter.household.id,
      invitedById: inviter.user.id,
      // Already past its own seven days when it was minted.
      now: new Date(Date.now() - INVITATION_TTL_MS - 60_000),
    });
    t.after(() =>
      cleanup({
        invitationIds: [invitation.id],
        householdIds: [inviter.household.id],
        userIds: [inviter.user.id],
      }),
    );

    const result = await acceptInvitation({ token, passwordHash: PASSWORD_HASH, name: "Too Late" });
    assert.deepEqual(result, { ok: false, error: "expired" });

    // Refused before anything is created — not a rollback of a half-finished
    // acceptance, but a check that never opened the transaction at all.
    assert.equal(await prisma.user.findUnique({ where: { email } }), null);
    assert.equal(
      await prisma.householdMembership.count({ where: { householdId: inviter.household.id } }),
      1, // the inviter, and nobody else
    );
  },
);

// --- Replay ---------------------------------------------------------------

test(
  "a link opened a second time is refused rather than joining twice",
  { skip: SKIP },
  async (t) => {
    const inviter = await makeInviter();
    const email = uniqueEmail("replay");
    const { invitation, token } = await issueInvitation({
      email,
      kind: "HOUSEHOLD",
      householdId: inviter.household.id,
      invitedById: inviter.user.id,
    });

    const first = await acceptInvitation({ token, passwordHash: PASSWORD_HASH, name: "Once" });
    assert.equal(first.ok, true);

    t.after(() =>
      cleanup({
        invitationIds: [invitation.id],
        householdIds: [inviter.household.id],
        userIds: [inviter.user.id, first.userId],
      }),
    );

    const second = await acceptInvitation({ token, passwordHash: PASSWORD_HASH, name: "Twice" });
    assert.deepEqual(second, { ok: false, error: "accepted" });

    assert.equal(
      await prisma.householdMembership.count({
        where: { householdId: inviter.household.id, userId: first.userId },
      }),
      1,
    );
    assert.equal(await prisma.user.count({ where: { email } }), 1);
  },
);

// --- Revocation -------------------------------------------------------------

test("a revoked invitation cannot be accepted", { skip: SKIP }, async (t) => {
  const inviter = await makeInviter();
  const email = uniqueEmail("revoked");
  const { invitation, token } = await issueInvitation({
    email,
    kind: "HOUSEHOLD",
    householdId: inviter.household.id,
    invitedById: inviter.user.id,
  });
  t.after(() =>
    cleanup({
      invitationIds: [invitation.id],
      householdIds: [inviter.household.id],
      userIds: [inviter.user.id],
    }),
  );

  const revoked = await revokeInvitation({ id: invitation.id });
  assert.equal(revoked, true);

  const result = await acceptInvitation({ token, passwordHash: PASSWORD_HASH, name: "Withdrawn" });
  assert.deepEqual(result, { ok: false, error: "revoked" });
  assert.equal(await prisma.user.findUnique({ where: { email } }), null);
});

test(
  "issuing a replacement invitation revokes the previous unused one for the same address and household",
  { skip: SKIP },
  async (t) => {
    const inviter = await makeInviter();
    const email = uniqueEmail("superseded");
    t.after(() => cleanup({ householdIds: [inviter.household.id], userIds: [inviter.user.id] }));

    const original = await issueInvitation({
      email,
      kind: "HOUSEHOLD",
      householdId: inviter.household.id,
      invitedById: inviter.user.id,
    });
    const replacement = await issueInvitation({
      email,
      kind: "HOUSEHOLD",
      householdId: inviter.household.id,
      invitedById: inviter.user.id,
    });

    const originalRow = await prisma.invitation.findUniqueOrThrow({ where: { id: original.invitation.id } });
    assert.notEqual(originalRow.revokedAt, null);
    // The replacement itself is untouched by its own supersede step.
    const replacementRow = await prisma.invitation.findUniqueOrThrow({
      where: { id: replacement.invitation.id },
    });
    assert.equal(replacementRow.revokedAt, null);

    // The old token is dead, not merely the row's revokedAt column — the same
    // fact checked the way a visitor actually presents it.
    const originalResult = await acceptInvitation({
      token: original.token,
      passwordHash: PASSWORD_HASH,
      name: "Superseded",
    });
    assert.deepEqual(originalResult, { ok: false, error: "revoked" });
  },
);

// --- Email mismatch -----------------------------------------------------------

test(
  "a session signed in under a different address is refused, and nothing is created",
  { skip: SKIP },
  async (t) => {
    const inviter = await makeInviter();
    const invitedEmail = uniqueEmail("invited");
    const signedInEmail = uniqueEmail("someone-else");
    const { invitation, token } = await issueInvitation({
      email: invitedEmail,
      kind: "HOUSEHOLD",
      householdId: inviter.household.id,
      invitedById: inviter.user.id,
    });
    t.after(() =>
      cleanup({
        invitationIds: [invitation.id],
        householdIds: [inviter.household.id],
        userIds: [inviter.user.id],
      }),
    );

    const result = await acceptInvitation({
      token,
      signedInEmail,
      passwordHash: PASSWORD_HASH,
      name: "Wrong Mailbox",
    });
    assert.deepEqual(result, { ok: false, error: "email-mismatch" });

    assert.equal(await prisma.user.findUnique({ where: { email: invitedEmail } }), null);
    assert.equal(await prisma.user.findUnique({ where: { email: signedInEmail } }), null);
    assert.equal(
      await prisma.householdMembership.count({ where: { householdId: inviter.household.id } }),
      1, // the inviter, still alone
    );
  },
);

// --- Existing users -----------------------------------------------------------

test(
  "an address with a working password, signed in as itself, joins without being asked for a new one, and the password is untouched",
  { skip: SKIP },
  async (t) => {
    const inviter = await makeInviter();
    const email = uniqueEmail("already-has-account");
    const existingUser = await prisma.user.create({
      data: { email, name: "Already Signed Up", passwordHash: PASSWORD_HASH },
    });
    const { invitation, token } = await issueInvitation({
      email,
      kind: "HOUSEHOLD",
      householdId: inviter.household.id,
      invitedById: inviter.user.id,
    });
    t.after(() =>
      cleanup({
        invitationIds: [invitation.id],
        householdIds: [inviter.household.id],
        userIds: [inviter.user.id, existingUser.id],
      }),
    );

    // No passwordHash supplied — the whole point of link-account. The
    // visitor's own session is what stands in for a password here, exactly
    // the way it would for a person who opened the link while already
    // signed in as themselves.
    const result = await acceptInvitation({ token, signedInEmail: email });
    assert.equal(result.ok, true);
    assert.equal(result.plan, "link-account");
    assert.equal(result.userId, existingUser.id);

    assert.equal(
      await prisma.householdMembership.count({
        where: { householdId: inviter.household.id, userId: existingUser.id, role: "ADMIN" },
      }),
      1,
    );

    const after = await prisma.user.findUniqueOrThrow({ where: { id: existingUser.id } });
    assert.equal(after.passwordHash, PASSWORD_HASH, "an existing password must survive byte-for-byte");
  },
);

// --- Account takeover via a bare token (the vulnerability this file guards) --

test(
  "an address with a working password CANNOT be joined anonymously — the token alone must never mint a session for an existing account",
  { skip: SKIP },
  async (t) => {
    const inviter = await makeInviter();
    const email = uniqueEmail("takeover-target");
    const existingUser = await prisma.user.create({
      data: { email, name: "Existing Victim", passwordHash: PASSWORD_HASH },
    });
    const { invitation, token } = await issueInvitation({
      email,
      kind: "HOUSEHOLD",
      householdId: inviter.household.id,
      invitedById: inviter.user.id,
    });
    t.after(() =>
      cleanup({
        invitationIds: [invitation.id],
        householdIds: [inviter.household.id],
        userIds: [inviter.user.id, existingUser.id],
      }),
    );

    // The attack: hold the raw token (mailed, forwarded, or handed back as
    // inviteUrl by an SMTP-less instance) and open it signed out. Before this
    // fix, acceptInvitation quietly treated that as if the invitation's own
    // address had been presented, refused nothing, and handed back
    // ok:true — which is exactly what the accept route turns into a session
    // cookie for the victim's account. `ok: false` here, not a session, is
    // the fix.
    const result = await acceptInvitation({ token });
    assert.deepEqual(result, { ok: false, error: "sign-in-required" });

    // Nothing about the victim's account moved: no new membership, and the
    // invitation itself is still live for a legitimate, signed-in attempt.
    assert.equal(
      await prisma.householdMembership.count({
        where: { householdId: inviter.household.id, userId: existingUser.id },
      }),
      0,
    );
    const stillLive = await prisma.invitation.findUniqueOrThrow({ where: { id: invitation.id } });
    assert.equal(stillLive.acceptedAt, null);
    assert.equal(stillLive.revokedAt, null);
  },
);

test(
  "the same address, opened anonymously and signed in as somebody else, is refused as a mismatch rather than sign-in-required",
  { skip: SKIP },
  async (t) => {
    const inviter = await makeInviter();
    const email = uniqueEmail("takeover-target-2");
    const attackerEmail = uniqueEmail("attacker");
    const existingUser = await prisma.user.create({
      data: { email, name: "Existing Victim", passwordHash: PASSWORD_HASH },
    });
    const attacker = await prisma.user.create({
      data: { email: attackerEmail, name: "Attacker", passwordHash: PASSWORD_HASH },
    });
    const { invitation, token } = await issueInvitation({
      email,
      kind: "HOUSEHOLD",
      householdId: inviter.household.id,
      invitedById: inviter.user.id,
    });
    t.after(() =>
      cleanup({
        invitationIds: [invitation.id],
        householdIds: [inviter.household.id],
        userIds: [inviter.user.id, existingUser.id, attacker.id],
      }),
    );

    // Being signed in as *some* account doesn't help an attacker either —
    // only a session for the invitation's own address does.
    const result = await acceptInvitation({ token, signedInEmail: attackerEmail });
    assert.deepEqual(result, { ok: false, error: "email-mismatch" });

    assert.equal(
      await prisma.householdMembership.count({
        where: { householdId: inviter.household.id, userId: existingUser.id },
      }),
      0,
    );
  },
);

// --- Concurrent acceptance ------------------------------------------------

test(
  "two simultaneous acceptances of a platform invitation produce exactly one household and one winner",
  { skip: SKIP },
  async (t) => {
    const inviter = await makeInviter();
    const email = uniqueEmail("racing");
    const householdName = `Race household ${randomUUID()}`;
    const { invitation, token } = await issueInvitation({
      email,
      kind: "PLATFORM",
      householdName,
      invitedById: inviter.user.id,
    });

    const [first, second] = await Promise.all([
      acceptInvitation({ token, passwordHash: PASSWORD_HASH, name: "Racer One" }),
      acceptInvitation({ token, passwordHash: PASSWORD_HASH, name: "Racer Two" }),
    ]);

    const outcomes = [first, second];
    const winners = outcomes.filter((r) => r.ok);
    const losers = outcomes.filter((r) => !r.ok);
    assert.equal(winners.length, 1, "exactly one of the two racing acceptances should win the claim");
    assert.equal(losers.length, 1);
    assert.deepEqual(losers[0], { ok: false, error: "accepted" });

    const createdHouseholdId = winners[0].householdId;
    t.after(() =>
      cleanup({
        invitationIds: [invitation.id],
        householdIds: [inviter.household.id, createdHouseholdId],
        userIds: [inviter.user.id, winners[0].userId],
      }),
    );

    // This is the expensive bug the atomic claim exists to prevent: a lost
    // race that still got as far as creating its own household, leaving one
    // household with a member and a second, identical one that nobody would
    // ever be told about.
    assert.equal(
      await prisma.household.count({ where: { name: householdName } }),
      1,
      "the losing acceptance must not have created a second household",
    );
    assert.equal(await prisma.user.count({ where: { email } }), 1);
  },
);

test(
  "a loser racing a HOUSEHOLD invitation is told 'accepted', never 'sign-in-required' — the stale-plan race this file regressed on",
  { skip: SKIP },
  async (t) => {
    // Both racers are anonymous and start out looking like create-account,
    // since nobody holds the address yet when the race begins. The bug this
    // pins: acceptInvitation resolves whether an account already exists (and
    // therefore what plan applies) from a read that isn't part of the claim,
    // so it can run *after* the winner's transaction has already created the
    // account and the membership. Before the fix, the loser's now-stale
    // "nobody exists yet" assumption flipped to already-a-member — a plan
    // that requires a sign-in nobody anonymous can supply — and it was
    // refused with `sign-in-required` instead of the truth, which is that the
    // link it was holding had simply already been spent. A HOUSEHOLD
    // invitation exercises the `already-a-member` branch of that same bug
    // (the PLATFORM race above only ever lands on `link-account`, since a
    // freshly-created household has no membership yet for the loser to find).
    const inviter = await makeInviter();
    const email = uniqueEmail("household-racing");
    const { invitation, token } = await issueInvitation({
      email,
      kind: "HOUSEHOLD",
      householdId: inviter.household.id,
      invitedById: inviter.user.id,
    });

    const [first, second] = await Promise.all([
      acceptInvitation({ token, passwordHash: PASSWORD_HASH, name: "Racer One" }),
      acceptInvitation({ token, passwordHash: PASSWORD_HASH, name: "Racer Two" }),
    ]);

    const outcomes = [first, second];
    const winners = outcomes.filter((r) => r.ok);
    const losers = outcomes.filter((r) => !r.ok);
    assert.equal(winners.length, 1, "exactly one of the two racing acceptances should win the claim");
    assert.equal(losers.length, 1);
    // The assertion that matters: not merely `ok: false`, but the specific,
    // deterministic reason — regardless of how the two racers' internal reads
    // happened to interleave.
    assert.deepEqual(losers[0], { ok: false, error: "accepted" });

    t.after(() =>
      cleanup({
        invitationIds: [invitation.id],
        householdIds: [inviter.household.id],
        userIds: [inviter.user.id, winners[0].userId],
      }),
    );

    assert.equal(
      await prisma.householdMembership.count({ where: { householdId: inviter.household.id } }),
      2, // the inviter, and exactly one winning racer — never both
    );
    assert.equal(await prisma.user.count({ where: { email } }), 1);
  },
);

// --- Cross-household denial -------------------------------------------------

test(
  "revoking an invitation scoped to the wrong household leaves it live",
  { skip: SKIP },
  async (t) => {
    const householdA = await prisma.household.create({ data: { name: `Household A ${randomUUID()}` } });
    const householdB = await prisma.household.create({ data: { name: `Household B ${randomUUID()}` } });
    const inviter = await makeInviter();
    const email = uniqueEmail("cross-household");
    const { invitation } = await issueInvitation({
      email,
      kind: "HOUSEHOLD",
      householdId: householdA.id,
      invitedById: inviter.user.id,
    });
    t.after(() =>
      cleanup({
        invitationIds: [invitation.id],
        householdIds: [householdA.id, householdB.id, inviter.household.id],
        userIds: [inviter.user.id],
      }),
    );

    // Household B has no such invitation to withdraw, so this must be a no-op
    // rather than reaching across into A's roster.
    const revokedFromB = await revokeInvitation({ id: invitation.id, householdId: householdB.id });
    assert.equal(revokedFromB, false);

    const stillLive = await prisma.invitation.findUniqueOrThrow({ where: { id: invitation.id } });
    assert.equal(stillLive.revokedAt, null);

    // Scoped to its own household, the same call succeeds.
    const revokedFromA = await revokeInvitation({ id: invitation.id, householdId: householdA.id });
    assert.equal(revokedFromA, true);
  },
);

test(
  "listPendingInvitations for one household never surfaces another household's invitations",
  { skip: SKIP },
  async (t) => {
    const householdA = await prisma.household.create({ data: { name: `Household A ${randomUUID()}` } });
    const householdB = await prisma.household.create({ data: { name: `Household B ${randomUUID()}` } });
    const inviter = await makeInviter();
    const { invitation: invitationA } = await issueInvitation({
      email: uniqueEmail("pending-a"),
      kind: "HOUSEHOLD",
      householdId: householdA.id,
      invitedById: inviter.user.id,
    });
    const { invitation: invitationB } = await issueInvitation({
      email: uniqueEmail("pending-b"),
      kind: "HOUSEHOLD",
      householdId: householdB.id,
      invitedById: inviter.user.id,
    });
    t.after(() =>
      cleanup({
        invitationIds: [invitationA.id, invitationB.id],
        householdIds: [householdA.id, householdB.id, inviter.household.id],
        userIds: [inviter.user.id],
      }),
    );

    const pendingForA = await listPendingInvitations(householdA.id);
    const pendingForB = await listPendingInvitations(householdB.id);

    assert.ok(pendingForA.some((row) => row.id === invitationA.id));
    assert.ok(!pendingForA.some((row) => row.id === invitationB.id));
    assert.ok(pendingForB.some((row) => row.id === invitationB.id));
    assert.ok(!pendingForB.some((row) => row.id === invitationA.id));
  },
);

// --- Platform invitations ---------------------------------------------------

test(
  "accepting a platform invitation creates a household, makes the invitee its admin, and leaves platformRole alone",
  { skip: SKIP },
  async (t) => {
    const inviter = await makeInviter();
    const email = uniqueEmail("platform");
    const householdName = `New household ${randomUUID()}`;
    const { invitation, token } = await issueInvitation({
      email,
      kind: "PLATFORM",
      householdName,
      invitedById: inviter.user.id,
    });

    const result = await acceptInvitation({
      token,
      passwordHash: PASSWORD_HASH,
      name: "New Admin",
      householdName,
    });
    assert.equal(result.ok, true);

    t.after(() =>
      cleanup({
        invitationIds: [invitation.id],
        householdIds: [inviter.household.id, result.householdId],
        userIds: [inviter.user.id, result.userId],
      }),
    );

    const membership = await prisma.householdMembership.findUniqueOrThrow({
      where: { householdId_userId: { householdId: result.householdId, userId: result.userId } },
    });
    assert.equal(membership.role, "ADMIN");

    const user = await prisma.user.findUniqueOrThrow({ where: { id: result.userId } });
    assert.equal(user.platformRole, "USER", "joining a household is not the same as administering the box");

    // The check constraint (see the migration) permits householdId on a
    // PLATFORM row only once acceptedAt is set — which is exactly the state
    // this row should be in now.
    const acceptedRow = await prisma.invitation.findUniqueOrThrow({ where: { id: invitation.id } });
    assert.equal(acceptedRow.householdId, result.householdId);
    assert.notEqual(acceptedRow.acceptedAt, null);

    // And the constraint bites the other way too: the same shape without an
    // acceptedAt is not a row the database will hold, whichever code path
    // tries to write it. (The wording of Postgres's error isn't pinned here —
    // only that the write is refused — so a Prisma upgrade that rephrases the
    // message can't turn this into a false failure.)
    const disallowedTokenHash = await hashToken(randomUUID());
    await assert.rejects(() =>
      prisma.invitation.create({
        data: {
          tokenHash: disallowedTokenHash,
          email: uniqueEmail("constraint-check"),
          kind: "PLATFORM",
          householdId: result.householdId,
          expiresAt: new Date(Date.now() + INVITATION_TTL_MS),
        },
      }),
    );
  },
);
