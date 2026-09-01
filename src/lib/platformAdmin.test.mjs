// Tests for the platform-administration rules (§9, §9c). Run with `npm test`.
//
// Everything in src/lib/platformAdmin.ts is a total function of the caller and
// the state it is asked to change, which is the whole point of splitting it
// out of the routes that call it: an authorization rule that can only be
// exercised by standing up a server and holding four different cookies is a
// rule nobody tests exhaustively. These take a plain Caller object and answer
// in microseconds, so the whole matrix — anonymous, household member,
// household admin, platform admin — is checked for every operation on every
// `npm test`. The database-backed half of this area (the audit trail itself)
// is covered in src/lib/platformAudit.integration.test.mjs.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import {
  operationalAccess,
  platformScreenAccess,
  roleInterventionRefusal,
  removalInterventionRefusal,
  platformRoleChangeRefusal,
} from "./platformAdmin.ts";

const ANONYMOUS = { platformRole: null };
// The point this whole file exists to hammer home: a household member and a
// household admin are the *same caller* as far as operationalAccess is
// concerned. Both hold platformRole "USER" — HouseholdRole ("ADMIN" versus
// "MEMBER") lives on the membership row, not on the user, and this module
// never sees it. Giving these two objects different names rather than one
// shared "USER" constant is deliberate: it is the exact confusion the old
// code embodied, where every backup and SMTP endpoint accepted any signed-in
// account regardless of which kitchen it belonged to.
const HOUSEHOLD_MEMBER = { platformRole: "USER" };
const HOUSEHOLD_ADMIN = { platformRole: "USER" };
const PLATFORM_ADMIN = { platformRole: "ADMIN" };

// --- operationalAccess ---------------------------------------------------------

test("an anonymous caller is unauthorized, not merely forbidden, from an operational endpoint", () => {
  assert.equal(operationalAccess(ANONYMOUS), "unauthorized");
});

test("a household member is forbidden from operational endpoints — being signed in is not enough", () => {
  assert.equal(operationalAccess(HOUSEHOLD_MEMBER), "forbidden");
});

test("a household admin is forbidden too — administering a kitchen is not administering the box", () => {
  // This is the case the plan calls out by name: household admins and
  // household members present the same platformRole ("USER") to this
  // function, because HouseholdRole is a fact about a membership row, not
  // about the user. A household admin reaching for the backup passphrase or
  // the SMTP settings is exactly the caller every one of these endpoints used
  // to wave through.
  assert.equal(operationalAccess(HOUSEHOLD_ADMIN), "forbidden");
});

test("a platform admin is allowed", () => {
  assert.equal(operationalAccess(PLATFORM_ADMIN), "allow");
});

test("a valid bearer token opens the door even for an anonymous caller — the cron job has no cookie jar", () => {
  assert.equal(operationalAccess({ platformRole: null, bearer: true }), "allow");
});

test("a bearer token still allows through when a platformRole happens to be attached", () => {
  // guardOperational never actually constructs this combination — bearer
  // requests carry no user — but the rule itself should not depend on the
  // rest of the object once bearer is true.
  assert.equal(operationalAccess({ platformRole: "USER", bearer: true }), "allow");
});

// --- platformScreenAccess -------------------------------------------------------
//
// Same matrix as operationalAccess, except for the one place the two
// functions are required to diverge: the bearer door.

test("an anonymous caller is unauthorized from the platform-admin screens", () => {
  assert.equal(platformScreenAccess(ANONYMOUS), "unauthorized");
});

test("a household member is forbidden from the platform-admin screens", () => {
  assert.equal(platformScreenAccess(HOUSEHOLD_MEMBER), "forbidden");
});

test("a household admin is forbidden from the platform-admin screens — same caller as a household member here too", () => {
  assert.equal(platformScreenAccess(HOUSEHOLD_ADMIN), "forbidden");
});

test("a platform admin is allowed onto the platform-admin screens", () => {
  assert.equal(platformScreenAccess(PLATFORM_ADMIN), "allow");
});

test("a bearer token does NOT open the platform-admin screens, unlike operationalAccess", () => {
  // This is the one place the two functions must disagree, so it is asserted
  // directly rather than left to be inferred from the matrix above. A shared
  // secret authenticates a script driving one known operation — the nightly
  // backup answering CRON_SECRET — never a way to browse every household's
  // membership from a terminal that merely knows the secret.
  assert.equal(operationalAccess({ platformRole: null, bearer: true }), "allow");
  assert.equal(platformScreenAccess({ platformRole: null, bearer: true }), "unauthorized");
});

// --- roleInterventionRefusal -----------------------------------------------------

test("a household member may not use the role intervention — only a platform admin may", () => {
  const refusal = roleInterventionRefusal({
    caller: HOUSEHOLD_MEMBER,
    target: { role: "MEMBER" },
    nextRole: "ADMIN",
    adminCount: 1,
  });
  assert.equal(refusal, "not-platform-admin");
});

test("a household admin may not use the role intervention either — the same non-answer as a member", () => {
  const refusal = roleInterventionRefusal({
    caller: HOUSEHOLD_ADMIN,
    target: { role: "MEMBER" },
    nextRole: "ADMIN",
    adminCount: 1,
  });
  assert.equal(refusal, "not-platform-admin");
});

test("a platform admin acting on somebody who isn't a member of the household is refused as such", () => {
  const refusal = roleInterventionRefusal({
    caller: PLATFORM_ADMIN,
    target: null,
    nextRole: "ADMIN",
    adminCount: 1,
  });
  assert.equal(refusal, "not-a-member");
});

test("a platform admin may not demote the last remaining admin — that is the deadlock this exists to repair, not to cause", () => {
  const refusal = roleInterventionRefusal({
    caller: PLATFORM_ADMIN,
    target: { role: "ADMIN" },
    nextRole: "MEMBER",
    adminCount: 1,
  });
  assert.equal(refusal, "last-admin");
});

test("a platform admin may demote an admin when the household has two of them", () => {
  const refusal = roleInterventionRefusal({
    caller: PLATFORM_ADMIN,
    target: { role: "ADMIN" },
    nextRole: "MEMBER",
    adminCount: 2,
  });
  assert.equal(refusal, null);
});

test("a platform admin may promote a plain member to admin", () => {
  const refusal = roleInterventionRefusal({
    caller: PLATFORM_ADMIN,
    target: { role: "MEMBER" },
    nextRole: "ADMIN",
    adminCount: 1,
  });
  assert.equal(refusal, null);
});

test("promoting a member is allowed even when adminCount is 0 — the stranded-household repair case", () => {
  // A household can end up with no admin at all — its only admin's account
  // was deleted, say — and that is precisely the household this intervention
  // exists to rescue. The last-admin guard only ever fires on a demotion
  // (nextRole "MEMBER"), so it must never stand in the way of handing a
  // household its very first admin back.
  const refusal = roleInterventionRefusal({
    caller: PLATFORM_ADMIN,
    target: { role: "MEMBER" },
    nextRole: "ADMIN",
    adminCount: 0,
  });
  assert.equal(refusal, null);
});

// --- removalInterventionRefusal ---------------------------------------------------

test("a household member may not remove anybody via the platform intervention", () => {
  const refusal = removalInterventionRefusal({
    caller: HOUSEHOLD_MEMBER,
    target: { role: "MEMBER" },
  });
  assert.equal(refusal, "not-platform-admin");
});

test("a household admin may not remove anybody via the platform intervention either", () => {
  const refusal = removalInterventionRefusal({
    caller: HOUSEHOLD_ADMIN,
    target: { role: "MEMBER" },
  });
  assert.equal(refusal, "not-platform-admin");
});

test("a platform admin removing somebody who isn't on the roster is refused as such", () => {
  const refusal = removalInterventionRefusal({ caller: PLATFORM_ADMIN, target: null });
  assert.equal(refusal, "not-a-member");
});

test("a platform admin may remove the last remaining admin — winding a household up is deliberately allowed here", () => {
  // The documented difference from roleInterventionRefusal: demoting the last
  // admin is refused because it would leave a household nobody can
  // administer, but removing them entirely is how a household is wound up on
  // purpose, and refusing it would leave abandoned households on the box for
  // ever with no way to clear them. What it costs, instead of a refusal, is a
  // row in the audit trail.
  const refusal = removalInterventionRefusal({
    caller: PLATFORM_ADMIN,
    target: { role: "ADMIN" },
  });
  assert.equal(refusal, null);
});

test("a platform admin may remove a plain member too", () => {
  const refusal = removalInterventionRefusal({
    caller: PLATFORM_ADMIN,
    target: { role: "MEMBER" },
  });
  assert.equal(refusal, null);
});

// --- platformRoleChangeRefusal ---------------------------------------------------
//
// Nothing calls this yet: promotion to platform admin is not offered anywhere
// in the product, so there is no screen for this rule to guard. It is written
// down and tested here because the plan asks what would happen if promotion
// were added, and the answer is easier to get right once, in the open, than
// inside the pull request that adds the button.

test("promotion to platform admin is always allowed for a platform admin, whoever the target is", () => {
  const refusal = platformRoleChangeRefusal({
    caller: { platformRole: "ADMIN", userId: "admin-1" },
    target: { userId: "user-2", platformRole: "USER" },
    nextRole: "ADMIN",
  });
  assert.equal(refusal, null);
});

test("a platform admin may not demote themselves — that would lock the last operator out of their own installation", () => {
  const refusal = platformRoleChangeRefusal({
    caller: { platformRole: "ADMIN", userId: "admin-1" },
    target: { userId: "admin-1", platformRole: "ADMIN" },
    nextRole: "USER",
  });
  assert.equal(refusal, "self");
});

test("a platform admin may not demote a peer platform admin — the same equals-cannot-demote-equals rule as households", () => {
  const refusal = platformRoleChangeRefusal({
    caller: { platformRole: "ADMIN", userId: "admin-1" },
    target: { userId: "admin-2", platformRole: "ADMIN" },
    nextRole: "USER",
  });
  assert.equal(refusal, "peer-platform-admin");
});

test("a platform admin may demote an ordinary user with the platform role of USER — trivially, since they were never elevated", () => {
  const refusal = platformRoleChangeRefusal({
    caller: { platformRole: "ADMIN", userId: "admin-1" },
    target: { userId: "user-2", platformRole: "USER" },
    nextRole: "USER",
  });
  assert.equal(refusal, null);
});

test("a non-platform-admin may not change anybody's platform role", () => {
  const refusal = platformRoleChangeRefusal({
    caller: { platformRole: "USER", userId: "member-1" },
    target: { userId: "user-2", platformRole: "USER" },
    nextRole: "ADMIN",
  });
  assert.equal(refusal, "not-platform-admin");
});

// --- Structural: every operational endpoint is actually gated -------------------
//
// The rule "every operational endpoint is platform-admin gated" is only as
// good as the newest route file, and the matrix above proves nothing about
// whether a route remembered to call it. The honest way to check that is to
// run all four kinds of caller against a live server, but that needs a
// running Next.js instance and four sets of cookies, and a test that
// expensive is one that quietly gets skipped or deleted the day it's
// inconvenient. Reading the route source is cheap, always runs, and catches
// exactly the mistake this area's history is made of: a handler that reads
// `currentUser()`, checks that it isn't null, and calls that authorization.

const SRC_APP_API = path.resolve(import.meta.dirname, "../app/api");

// The ten endpoints the plan names by hand, each path relative to
// src/app/api/ — the exact list in the task, so a route quietly dropped from
// it is a diff to this file, not a silent gap.
const OPERATIONAL_ROUTE_PATHS = [
  "backup/route.ts",
  "backup/check/route.ts",
  "backup/init/route.ts",
  "backup/key/route.ts",
  "backup/run/route.ts",
  "mail/test/route.ts",
  "admin/invitations/route.ts",
  "admin/households/route.ts",
  "admin/households/[id]/members/route.ts",
  "admin/audit/route.ts",
];

test("every listed operational route imports and calls the shared guard, not a bare currentUser() check", () => {
  for (const relativePath of OPERATIONAL_ROUTE_PATHS) {
    const fullPath = path.join(SRC_APP_API, relativePath);
    const source = fs.readFileSync(fullPath, "utf8");

    assert.match(
      source,
      /from\s+["']@\/lib\/opsGuard["']/,
      `${relativePath} must import guardOperational from @/lib/opsGuard`,
    );
    assert.match(
      source,
      /guardOperational\s*\(/,
      `${relativePath} must call guardOperational(...)`,
    );

    // The exact regression this test exists to catch: every one of these
    // endpoints used to read "is anybody signed in?" via currentUser() and
    // treat that as authorization. guardOperational never needs to reach for
    // currentUser() itself — operationalCaller does that internally — so a
    // route that still imports or calls it directly has either kept the old
    // pattern alongside the new one, or never removed it.
    assert.doesNotMatch(
      source,
      /currentUser\s*\(/,
      `${relativePath} must not fall back to a bare currentUser() check`,
    );
  }
});

/** Every route.ts under a directory, found on disk rather than hand-listed. */
function findRouteFiles(dir) {
  const found = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const entryPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      found.push(...findRouteFiles(entryPath));
    } else if (entry.isFile() && entry.name === "route.ts") {
      found.push(entryPath);
    }
  }
  return found;
}

test("every route under src/app/api/admin, however new, calls guardOperational — nothing added later can quietly skip the gate", () => {
  const adminDir = path.join(SRC_APP_API, "admin");
  const routeFiles = findRouteFiles(adminDir);

  // If this ever finds nothing, the glob itself is broken and every
  // assertion below would pass vacuously — worse than not having the test.
  assert.ok(routeFiles.length > 0, "expected to find at least one route.ts under src/app/api/admin");

  for (const filePath of routeFiles) {
    const source = fs.readFileSync(filePath, "utf8");
    const relative = path.relative(SRC_APP_API, filePath);
    assert.match(
      source,
      /guardOperational\s*\(/,
      `${relative} is under src/app/api/admin and must call guardOperational(...)`,
    );
  }
});
