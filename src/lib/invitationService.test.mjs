// Tests for the audit sentence written when a link is spent (§9c, Phase 6).
// Run with `npm test`.
//
// acceptanceDetail and membershipJoinedDetail in src/lib/invitationService.ts
// are pure — a plan, a household name and a flag in, one sentence out — kept
// that way on purpose so the three shapes an acceptance can take (a new
// household, an existing one joined, a link reopened on a membership that was
// already there) are checked here rather than only by eye in the admin
// screen. No Postgres involved: unlike
// src/lib/invitations.integration.test.mjs, nothing below calls
// acceptInvitation itself, so there is no SKIP guard to write.
//
// invitationService.ts reaches Prisma, mail and the email templates through
// the `@/` path alias, which only Next.js and `tsc` resolve — not a bare
// `node --test`. The same small resolution hook invitations.integration.test.mjs
// registers for that reason is registered here too, so importing the module
// at all doesn't throw on the first `@/lib/prisma` it meets; nothing below
// this file's imports ever performs a query.

import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import path from "node:path";

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

const { acceptanceDetail, membershipJoinedDetail } = await import("./invitationService.ts");

// --- acceptanceDetail ------------------------------------------------------

test("a platform invitation being accepted for the first time says a household was created", () => {
  const detail = acceptanceDetail({
    email: "sam@example.com",
    householdName: "Fynbos",
    householdCreated: true,
    plan: "create-account",
  });
  assert.equal(detail, "sam@example.com accepted an invitation and created Fynbos.");
});

test("a household invitation accepted by a brand new account says they joined", () => {
  const detail = acceptanceDetail({
    email: "sam@example.com",
    householdName: "Fynbos",
    householdCreated: false,
    plan: "create-account",
  });
  assert.equal(detail, "sam@example.com accepted an invitation and joined Fynbos as an admin.");
});

test("an already-registered address linking into a second household reads the same as a new one — the plan is create-vs-link, not household-vs-not", () => {
  const created = acceptanceDetail({
    email: "sam@example.com",
    householdName: "Fynbos",
    householdCreated: false,
    plan: "link-account",
  });
  assert.equal(created, "sam@example.com accepted an invitation and joined Fynbos as an admin.");
});

test("reopening a link to a household you're already in says so instead of claiming a fresh join", () => {
  const detail = acceptanceDetail({
    email: "sam@example.com",
    householdName: "Fynbos",
    householdCreated: false,
    plan: "already-a-member",
  });
  assert.equal(
    detail,
    "sam@example.com reopened an invitation to Fynbos, which they already belonged to.",
  );
});

test("already-a-member wins even where householdCreated is (impossibly) true — the membership fact is checked first", () => {
  // This combination can't actually arise (a freshly created household has no
  // existing members to already belong to it), but the function is total, and
  // "already a member" is the one case the acceptance genuinely didn't
  // change anything, so it must never be shadowed by the created-household
  // wording.
  const detail = acceptanceDetail({
    email: "sam@example.com",
    householdName: "Fynbos",
    householdCreated: true,
    plan: "already-a-member",
  });
  assert.equal(
    detail,
    "sam@example.com reopened an invitation to Fynbos, which they already belonged to.",
  );
});

// --- membershipJoinedDetail --------------------------------------------------

test("the first admin of a newly created household is named as such", () => {
  const detail = membershipJoinedDetail({
    email: "sam@example.com",
    householdName: "Fynbos",
    householdCreated: true,
  });
  assert.equal(detail, "sam@example.com became the first admin of Fynbos.");
});

test("joining an existing household reads as joining, not founding", () => {
  const detail = membershipJoinedDetail({
    email: "sam@example.com",
    householdName: "Fynbos",
    householdCreated: false,
  });
  assert.equal(detail, "sam@example.com joined Fynbos as an admin, via invitation.");
});
