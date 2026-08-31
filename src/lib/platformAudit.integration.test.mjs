// End-to-end tests of the audit trail (§9c). Run with `npm test`, against a
// real Postgres.
//
// src/lib/audit.ts is two thin functions wrapped around Prisma, and the whole
// reason they earn an integration test rather than a mock is the one property
// that only a real database can prove: the snapshot columns
// (actorEmail, householdName, subjectEmail) survive the row they were copied
// from being deleted. A schema change that turned those columns into a join
// instead — or that switched the foreign keys from ON DELETE SET NULL to
// CASCADE — would pass a unit test built on a mock and would silently delete
// the evidence of an intervention the day somebody removed the account or
// wound up the household it named. That is the single most important test in
// this file.
//
// It needs a reachable DATABASE_URL and skips itself without one, so a laptop
// with no Postgres running still gets a green `npm test`. Every test builds
// its own fixtures with unique values and cleans them up in `t.after`, so the
// file is safe to run twice in a row against the same database.
//
// A note on how this file gets to call the real module at all: src/lib/audit.ts
// reaches Prisma through the `@/` path alias, which only Next.js and `tsc`
// know how to resolve, not a bare `node --test`. Rather than reimplement the
// interesting half of it against `@prisma/client` directly (which would test a
// copy of the logic, not the logic), this file registers the same
// module-resolution hook src/lib/invitations.integration.test.mjs uses, which
// rewrites `@/x` to the real file at `src/x.ts` before importing anything.

import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import path from "node:path";
import { randomUUID } from "node:crypto";

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
const { recordAudit, recentAudit } = await import("@/lib/audit");

/**
 * Whether there is a database to test against, checked once at module load —
 * the same shape as src/lib/invitations.integration.test.mjs, so a missing
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

function uniqueEmail(label) {
  return `${label}-${randomUUID()}@platform-audit.test`;
}

/** Delete rows created for a test, tolerant of some already being gone. */
async function cleanup({ auditEventIds = [], householdIds = [], userIds = [] } = {}) {
  if (auditEventIds.length) {
    await prisma.auditEvent.deleteMany({ where: { id: { in: auditEventIds } } });
  }
  if (householdIds.length) {
    await prisma.household.deleteMany({ where: { id: { in: householdIds } } });
  }
  if (userIds.length) {
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  }
}

// --- recordAudit writes the snapshot, recentAudit reads it back --------------

test(
  "recordAudit writes a row with the snapshot columns populated, and recentAudit returns it",
  { skip: SKIP },
  async (t) => {
    const household = await prisma.household.create({
      data: { name: `Audited household ${randomUUID()}` },
    });
    const actorEmail = uniqueEmail("actor");
    const actor = await prisma.user.create({ data: { email: actorEmail, name: "Actor" } });
    const subjectEmail = uniqueEmail("subject");

    t.after(() => cleanup({ householdIds: [household.id], userIds: [actor.id] }));

    await recordAudit({
      action: "HOUSEHOLD_ROLE_CHANGED",
      actor: { id: actor.id, email: actor.email },
      household: { id: household.id, name: household.name },
      subjectEmail,
      detail: `Made ${subjectEmail} an admin of ${household.name}.`,
    });

    const rows = await prisma.auditEvent.findMany({ where: { householdId: household.id } });
    assert.equal(rows.length, 1);
    const [row] = rows;
    t.after(() => cleanup({ auditEventIds: [row.id] }));

    assert.equal(row.action, "HOUSEHOLD_ROLE_CHANGED");
    assert.equal(row.actorId, actor.id);
    assert.equal(row.actorEmail, actorEmail);
    assert.equal(row.householdId, household.id);
    assert.equal(row.householdName, household.name);
    assert.equal(row.subjectEmail, subjectEmail);
    assert.equal(row.detail, `Made ${subjectEmail} an admin of ${household.name}.`);

    const recent = await recentAudit();
    assert.ok(
      recent.some((entry) => entry.id === row.id && entry.subjectEmail === subjectEmail),
      "recentAudit should surface the row just written",
    );
  },
);

test(
  "recentAudit returns events newest first",
  { skip: SKIP },
  async (t) => {
    const householdA = await prisma.household.create({ data: { name: `Order household A ${randomUUID()}` } });
    const householdB = await prisma.household.create({ data: { name: `Order household B ${randomUUID()}` } });
    t.after(() => cleanup({ householdIds: [householdA.id, householdB.id] }));

    // recordAudit doesn't take an explicit timestamp, so the ordering under
    // test is createdAt's own default — two writes, one straight after the
    // other, must come back in the order they actually happened rather than
    // insertion order coinciding with it by luck. A short, deliberate pause
    // between them keeps the two createdAt values apart on databases with
    // coarser-than-microsecond clocks.
    await recordAudit({
      action: "HOUSEHOLD_MEMBER_REMOVED",
      household: { id: householdA.id, name: householdA.name },
      subjectEmail: uniqueEmail("first"),
      detail: "First event, should sort after the second.",
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    await recordAudit({
      action: "HOUSEHOLD_MEMBER_REMOVED",
      household: { id: householdB.id, name: householdB.name },
      subjectEmail: uniqueEmail("second"),
      detail: "Second event, should sort first.",
    });

    const rows = await prisma.auditEvent.findMany({
      where: { householdId: { in: [householdA.id, householdB.id] } },
    });
    t.after(() => cleanup({ auditEventIds: rows.map((row) => row.id) }));

    const recent = await recentAudit(10);
    const relevant = recent.filter((entry) =>
      entry.householdName === householdA.name || entry.householdName === householdB.name,
    );
    assert.equal(relevant.length, 2);
    assert.equal(relevant[0].householdName, householdB.name, "the second, later write should come back first");
    assert.equal(relevant[1].householdName, householdA.name);
  },
);

// --- The snapshot survives deletion --------------------------------------------

test(
  "the audit row survives deleting both the actor and the household it named — the snapshot columns are the whole point",
  { skip: SKIP },
  async (t) => {
    const household = await prisma.household.create({
      data: { name: `Wound-up household ${randomUUID()}` },
    });
    const actorEmail = uniqueEmail("outgoing-admin");
    const actor = await prisma.user.create({ data: { email: actorEmail, name: "Outgoing Admin" } });
    const subjectEmail = uniqueEmail("removed-member");

    await recordAudit({
      action: "HOUSEHOLD_MEMBER_REMOVED",
      actor: { id: actor.id, email: actorEmail },
      household: { id: household.id, name: household.name },
      subjectEmail,
      detail: `Removed ${subjectEmail} from ${household.name}.`,
    });

    const [row] = await prisma.auditEvent.findMany({
      where: { householdId: household.id, actorId: actor.id },
    });
    assert.ok(row, "expected the audit row to exist before either foreign key is deleted");
    t.after(() => cleanup({ auditEventIds: [row.id] }));

    // Both the acting user and the household named in the row are deleted —
    // exactly the sequence real life produces: a platform admin winds a
    // household up, and at some later point the outgoing admin's own account
    // is deleted too. Neither deletion is allowed to touch the record of what
    // was done.
    await prisma.household.delete({ where: { id: household.id } });
    await prisma.user.delete({ where: { id: actor.id } });

    const survivor = await prisma.auditEvent.findUnique({ where: { id: row.id } });
    assert.ok(survivor, "the AuditEvent row must still exist after the actor and household are gone");
    assert.equal(survivor.actorId, null, "the foreign key to the deleted user must be nulled, not left dangling");
    assert.equal(survivor.householdId, null, "the foreign key to the deleted household must be nulled, not left dangling");

    // The facts a schema change to cascading deletes would erase.
    assert.equal(survivor.actorEmail, actorEmail);
    assert.equal(survivor.householdName, household.name);
    assert.equal(survivor.subjectEmail, subjectEmail);
  },
);

// --- recordAudit never throws --------------------------------------------------

test(
  "recordAudit resolves rather than rejecting when the write itself is invalid",
  { skip: SKIP },
  async () => {
    // "PLATFORM_INVITATION_SENT" spelled wrong enough to not be a member of
    // the AuditAction enum: Postgres will refuse the insert, and the module
    // comment is explicit about why that must not become an exception the
    // caller has to catch — the act being audited has already happened by the
    // time recordAudit is called, and refusing to acknowledge that would leave
    // the operation itself failing over a logging problem.
    await assert.doesNotReject(() =>
      recordAudit({
        action: "NOT_A_REAL_AUDIT_ACTION",
        detail: "This write should fail silently, not throw.",
      }),
    );

    // And it really didn't write anything either — a caught error still
    // shouldn't have produced a row.
    const rows = await prisma.auditEvent.findMany({
      where: { detail: "This write should fail silently, not throw." },
    });
    assert.equal(rows.length, 0);
  },
);

// --- recentAudit clamps its limit -----------------------------------------------

test(
  "recentAudit clamps its limit to between 1 and 200",
  { skip: SKIP },
  async () => {
    // These are read straight back as the `take` Prisma was actually asked
    // for, via a spy on the query rather than by creating 200+ rows — the
    // clamping is arithmetic, not a fact about how much data exists, and
    // asserting on the query itself keeps this fast and independent of
    // whatever the database already holds.
    const calls = [];
    const originalFindMany = prisma.auditEvent.findMany;
    prisma.auditEvent.findMany = (args) => {
      calls.push(args);
      return originalFindMany.call(prisma.auditEvent, args);
    };
    try {
      await recentAudit(0);
      await recentAudit(-5);
      await recentAudit(500);
      await recentAudit(50);
    } finally {
      prisma.auditEvent.findMany = originalFindMany;
    }

    assert.equal(calls[0].take, 1, "an implausibly low limit must clamp up to 1, not ask for nothing");
    assert.equal(calls[1].take, 1, "a negative limit must clamp up to 1 too");
    assert.equal(calls[2].take, 200, "an implausibly high limit must clamp down to 200");
    assert.equal(calls[3].take, 50, "an ordinary limit inside the range must pass through unchanged");
  },
);
