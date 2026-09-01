# Remaining multi-household and public-access plan

## Stopping point

Phases 1–6 are complete, including the independent review that gated them.
The review's findings and the fixes that answered them are recorded under
"The final review" below, together with the two risks that were accepted
rather than fixed. **The exposure gate has passed**; see the bottom of this
document for what that does and does not license.

Phases 1–5:

- [x] Add households, memberships, household/platform roles, and deterministic migration of existing data.
- [x] Store an active household in each session and provide authorization helpers.
- [x] Require household ownership throughout plans, recipes, pantry, shopping, spending, settings, capture, dashboard, and weekly-digest queries.
- [x] Replace the account-shaped invitation with an invitation record, and add household administration.
- [x] Separate operating the installation from living in a household, and write down every intervention.

The security phase that this instruction waited on is now complete, so
**Tailscale Funnel or another HTTPS ingress is permitted** — read the exposure
gate at the bottom before turning one on, including the two deployment-time
checks it does not cover.

## Phase 4 — invitations and household administration

- [x] Add a dedicated invitation record containing a hashed token, normalized email, inviter, invitation type, optional target household, expiry, accepted timestamp, and revoked timestamp. — `Invitation` in `prisma/schema.prisma`, migration `20260831150000_add_household_invitations`.
- [x] Make links email-bound, single-use, seven-day credentials. Creating a replacement invitation revokes the previous unused one. — `issueInvitation` supersedes in one transaction; `acceptInvitation` claims with an `updateMany` filtered on `acceptedAt: null`.
- [x] Add a public `/invite/<token>` acceptance page; keep ordinary `/signup` unavailable. — there is no signup route, and middleware admits only `/invite/` and `/api/invitations/accept`.
- [x] Create membership only when the link is accepted. A household invitation grants household-admin membership; a platform invitation creates a new household with the invitee as its first household admin. — nothing creates `PLATFORM` invitations yet; the screen that does is Phase 5's.
- [x] Let an already-registered email accept an invitation without changing its password. — the `link-account` branch of `acceptancePlan`.
- [x] Let household admins send/revoke invitations and view their household roster. They may remove members but may not demote or remove another household admin. — `memberRemovalRefusal`, enforced in `/api/users` and reflected as a `removable` flag.
- [x] Add an active-household switcher for accounts belonging to multiple households.
- [x] Scope weekly-email preferences per household and make digest links select the relevant household before opening app content. — the opt-in moved to `HouseholdMembership`, the unsubscribe HMAC covers the household, and every digest link goes through `/open`.
- [x] Add integration tests for expiry, replay, revocation, email mismatch, existing users, concurrent acceptance, and cross-household denial. — `src/lib/invitations.test.mjs` and `src/lib/invitations.integration.test.mjs`; the integration file skips without a database. **Since Phase 6 these have been run against a real PostgreSQL 16 and pass.**

~~Carried into Phase 6: accounts invited under the old scheme still hold a membership and a live `INVITE` `AuthToken`, and still finish through `/reset`.~~ **Resolved in Phase 6.** The `INVITE` redemption path is gone and migration `20260901100000_retire_invite_auth_tokens` deletes the unspent rows; anyone stranded that way gets in via forgot-password, which was verified to work for an account whose `passwordHash` is null.

## Phase 5 — platform administration

- [x] Add a platform-admin screen for inviting people to create households and revoking pending invitations. — `/admin`, backed by `/api/admin/invitations`.
- [x] Enforce platform-admin authorization in the API for SMTP diagnostics, backup status/setup/run, and other installation-wide settings; hiding UI controls is not sufficient. — `guardOperational` in every one; the settings screen stops drawing the controls too, but the check is in the route.
- [x] Keep platform admin separate from household access. Platform admins receive no routine access to recipes, plans, shopping, pantry, or spending unless they are explicitly household members. — verified live: a platform admin can read another household's metadata and is refused 403 when selecting it.
- [x] Add a narrow intervention view for household membership metadata and peer-admin recovery/removal. Record every intervention; do not provide routine household-content browsing. — `/api/admin/households` selects membership metadata only; both interventions write an `AuditEvent`.
- [x] If promotion to platform admin is added, prevent platform admins from demoting themselves or another platform admin through the normal interface. — the condition did not trigger: no interface promotes anyone. The rule is written and tested as `platformRoleChangeRefusal` so the day a button appears it starts out right; nothing calls it yet.
- [x] Add authorization tests covering platform user, household admin, household member, and anonymous callers for every operational endpoint. — `src/lib/platformAdmin.test.mjs` (matrix plus a structural test that every operational and `/api/admin` route calls the guard) and `src/lib/platformAudit.integration.test.mjs`.

Verified live over HTTP against a scratch PostgreSQL, for every operational endpoint: anonymous 401, household member 403, household admin 403, platform admin 200. `CRON_SECRET` opens `POST /api/backup/run` and does not open the admin screens.

## Phase 6 — public-internet hardening

Done, verified by `npm test` (471 tests passing, none skipped after installing
`borg`), `npx tsc --noEmit`, `npm run build`, and `prisma migrate deploy`
against a scratch PostgreSQL 16:

- [x] Add persistent rate limits for login, password reset, invitation
      inspection/acceptance, and mail-sending endpoints. Key by both IP and
      normalized account/email where applicable. — `src/lib/rateLimitPolicy.ts`
      holds the table of limits and the arithmetic (pure); `src/lib/rateLimit.ts`
      does the counting. Counters are rows, not a map in the process, because
      this app restarts on every push and an in-memory limit forgets everything
      each time. The increment is a single upsert keyed on
      `(bucket, subject, windowStart)`, so twenty simultaneous attempts against
      a limit of ten yield exactly ten allowances — asserted for real, under
      real concurrency, in `src/lib/rateLimit.integration.test.mjs`. Subjects are
      stored as an `AUTH_SECRET`-keyed HMAC, so the table never accumulates a
      list of IP addresses or of email addresses somebody typed at a login form.
- [x] Add origin/CSRF protection to cookie-authenticated mutations and retain
      `SameSite`, `HttpOnly`, and production `Secure` cookies. — `src/lib/csrf.ts`,
      applied in `src/middleware.ts` ahead of the public/session split so it
      covers `/api/setup` and `/api/login` too. Bearer-authenticated and
      token-authenticated callers are exempt by rule rather than by a
      hand-maintained path list.
- [x] Add security headers: a tested Content Security Policy, `frame-ancestors
      'none'`, `nosniff`, a conservative referrer policy, and HSTS only after
      HTTPS is guaranteed. — `src/lib/securityHeaders.ts`, applied in middleware
      rather than `next.config.mjs` because the nonce must differ per response
      and static config is computed once at build time. `script-src` uses
      `'nonce-…' 'strict-dynamic'`, not `'unsafe-inline'`; `style-src` keeps
      `'unsafe-inline'` and says in a comment exactly what forced it.
      `Referrer-Policy: no-referrer`, chosen because reset and invite tokens sit
      in URL *paths*, so a referrer leak leaks a live credential. HSTS is gated
      on `httpsIsGuaranteed()` — production **and** an https `APP_URL` — since a
      wrong HSTS header on a hostname is very hard to undo.
- [x] Fail production startup when `AUTH_SECRET`, `APP_URL`, database
      credentials, or cron/backup secrets are missing, weak, or left at example
      values. — `src/lib/startupConfig.ts` (pure) called from `register()` in
      `src/instrumentation.ts`. Every problem is printed before exit, so a
      misconfigured deployment takes one restart to fix rather than five. The
      check is skipped when `NEXT_PHASE === "phase-production-build"`, because
      `next build` forces `NODE_ENV=production` while prerendering and a
      NODE_ENV-only check would fail CI image builds.
- [x] Audit public routes and remove obsolete invitation/reset paths. Ensure
      errors do not reveal whether an email address exists. — The `INVITE`
      `AuthToken` path is gone: the branch in `/reset/[token]`, the `isInvite`
      copy in `ResetForm`, and the `purpose` field that let any caller ask
      `/api/password/reset` to redeem an invite token. Migration
      `20260901100000_retire_invite_auth_tokens` deletes the leftover unspent
      rows; used ones are kept as history. Accounts stranded that way (a live
      membership with `passwordHash = null`) can still get in via
      forgot-password — verified in code before the tokens were deleted.
      `isPublic()` was audited entry by entry; the `startsWith("/icon")` prefix
      was replaced with the five exact filenames.
- [x] Add audit records for invitations, membership changes, platform
      interventions, SMTP checks, backup actions, password changes, and repeated
      authentication failures. — Nine new `AuditAction` values (migration
      `20260831170000_add_rate_limits_and_wider_audit`). `AUTH_THROTTLED` is
      recorded once per window rather than once per refused request, so a flood
      cannot turn the audit table into its own amplifier.
- [x] Review upload/capture size limits, outbound fetch protections (DNS/IP
      validation and redirect re-checking), logging, retention. — See the three
      findings below; dependency remediation is recorded in the completion
      checklist.

### What was found along the way

Three things turned up that the plan had not anticipated, all now fixed:

- **Stored XSS in the receipt path.** `POST /api/trips` and
  `PATCH /api/trips/[id]` wrote the uploader's own `photo.type` into the
  database unvalidated, and `GET /api/trips/[id]/receipt` served those bytes
  back under that exact `Content-Type` from the app's own origin — so a file
  announcing itself as `text/html` rendered as a document on the app origin. It
  needed an account to plant, which made it near-theoretical on a
  single-household tailnet box, and stops being theoretical at precisely the
  moment this phase is preparing for. Fixed on both sides in
  `src/lib/receiptPhoto.ts`: an allowlist at upload (excluding `image/svg+xml`,
  which a `startsWith("image/")` test would have admitted), and the stored type
  re-checked on the way out rather than echoed, since rows written earlier carry
  whatever their uploader claimed.
- **The outbound-fetch guard was not sound.** `resolvePublicUrl` checked the
  hostname *literal*, so `evil.example.com` with an A record of `127.0.0.1`
  passed straight through, and both fetches used `redirect: "follow"`, so an
  allowed URL could 302 to a link-local address. The blocklist also missed
  `100.64.0.0/10` — which is Tailscale's own range, meaning a pasted recipe URL
  could probe every other machine on the household's tailnet. Now
      `src/lib/privateNetwork.ts` (pure, exhaustively tested) plus a DNS-resolving
      `guardedFetch` that re-validates every redirect hop, caps the chain at
      five, and pins each socket to the exact public address it validated so a
      DNS rebinding answer cannot replace it between the check and connection.
- **Nothing collected dead credentials.** Expired `Session` rows were deleted
  only when somebody presented that exact cookie, so a closed browser or a
  replaced phone left its row forever; *used* `AuthToken` rows were deleted by
  nothing at all. `src/lib/retentionPolicy.ts` and `src/lib/retention.ts` add a
  daily sweep, with a 30-day grace on spent links so "was a reset issued for
  this account last Tuesday?" stays answerable. Verified against a real
  database that live sessions and in-grace tokens survive it.

## Phase 6 — the closing items (all done)

- [x] **Dependency vulnerabilities.** Next.js was updated from 15.5.20 to
      15.5.25, Sharp from 0.35.3 to 0.35.4, and nanoid to 3.3.18. npm overrides
      pin patched `postcss` and `deepmerge-ts` releases where Next and Prisma
      still declare vulnerable transitive versions. `npm audit` reports zero
      vulnerabilities, and Prisma generation, typechecking, all migrations,
      all tests, and the production build pass with the resulting graph.
- [x] **Manual two-household isolation test.** Exercised in production Firefox
      over a disposable HTTPS endpoint with two households carrying distinct
      recipes, plans, pantry items, shopping lists, trips and settings. Neither
      browser session observed the other's marker data in pages or APIs, and a
      platform admin received 403 when attempting to select the household they
      do not belong to.
- [x] **Manual browser verification of the CSP.** Exercised the dashboard, plan
      week, recipe library and detail page, cooking mode, shopping list,
      spending/receipt capture including a successful OCR request, settings,
      service-worker registration and the offline page in production Firefox
      over HTTPS. This caught and fixed an inline `onclick` on the offline page
      and an implicit-locale month formatter that caused `/plan` to hydrate with
      different text in a Danish browser. The rerun completed without CSP,
      console, hydration or request failures.
- [x] **Independent standards and specification review**, resolving all
      high-severity findings. The first `/code-review` pass against the
      merge-base found unsafe production-startup gaps and a DNS rebinding gap;
      both are fixed, along with its documentation-boundary and mail-limit/audit
      findings. The follow-up review is recorded in "The final review" below:
      it ran three independent passes over the eight multi-household and
      public-access commits, and everything it raised is either fixed or
      written down as an accepted risk.
- [x] **A backup restore rehearsal.** Installed Borg 1.4.5, ran the application's
      real `pg_dump` → encrypted `repokey-blake2` archive path against the
      scratch PostgreSQL database, extracted `mealplanner.sql`, restored it into
      a fresh database, and queried representative recipe, pantry, spending and
      settings data successfully.

## The final review

Three independent passes over the eight commits from `aef8e4b` to `HEAD` — the
multi-household and public-access work, 122 files. They were run separately and
in parallel so that no pass could be talked round by another's conclusions.

**Specification.** Clean. Every `[x]` above was re-derived from the code rather
than taken on trust. The pass that matters is the household-scoping one: it
enumerated every route under `src/app/api/` — roughly forty-five of them,
including the awkward ones (`plan/move`'s slot lookups, `recipes/export`,
`trips/[id]/receipt`, `capture`, `newsletter/send`, the `backup/*` family) —
and **found no unscoped query**. No scope creep either; `Cross-Origin-Opener-Policy`
and `Permissions-Policy` go slightly past the written header list and are the
only additions beyond it.

**Standards.** No hard violation of anything DESIGN.md documents. Four
judgement calls, two acted on: a duplicated handler skeleton in
`/api/admin/households/[id]/members` (PATCH and DELETE both did load → find
membership → look up subject email → record audit, now two shared helpers), and
an `if (!actor)` branch that cannot fire, kept with a comment rather than
deleted because this codebase states invariants instead of relying on them
silently. The two left alone are `platformRoleChangeRefusal` (unreachable, but
§9c argues for writing the rule before the button exists) and
`roleChangeRefusal`'s pass-through alias. It also considered whether the
`where: { householdId }` repetition across ~30 routes is Shotgun Surgery and
concluded it is not — it is the intrinsic shape of "every query is scoped", and
the authorization logic behind it is already centralized.

**Security.** One HIGH, two MEDIUM, four LOW. The six areas checked and found
clean: tenant isolation/IDOR, the platform-admin/household separation,
session and credential handling, request-level defenses (the per-response
128-bit CSP nonce was checked against a real `next build && next start`, not
read off the source), injection and SSRF, and information disclosure.

### The high-severity finding: an invitation was a bearer credential

`acceptanceRefusal` was given a pre-resolved address, and `acceptInvitation`
computed it as `signedInEmail ?? invitation.email`. An anonymous caller
therefore always satisfied the email binding — which is correct and necessary
when nobody holds the address yet, and indefensible once somebody does.
`acceptancePlan` returns `link-account` for an address that already has a
password, `needsPassword` is false for it, and the accept route ends by issuing
a session. So **the token alone signed you in as an existing account.**

Two ways to hold that token without owning the mailbox. `POST /api/invitations`
returns the raw link to the inviter whenever mail was not delivered, which is
exactly when SMTP is unconfigured — and SMTP is optional and unchecked at
startup. And an invitation mail, once forwarded, does the same thing with SMTP
working perfectly. Every invitee is granted `ADMIN`, so any household admin
could invite a platform admin's address and take the account.

Fixed in `src/lib/invitations.ts`: `acceptanceRefusal` now takes
`{ signedInEmail, plan }`, the `?? invitation.email` fallback is gone, and a
new `sign-in-required` refusal covers both plans that resolve to an existing
account. `already-a-member` needed it too — spending it looks like a no-op, but
it still looks the account up and still hands back a session. `create-account`
is untouched: a new person must still be able to accept from a signed-out
browser. As defense in depth, `inviteUrl` is now withheld from the inviter
whenever the invited address already has an account, in both the household and
the platform route, with a `linkWithheld` signal the two screens render.

Fixing this introduced a race, caught by an existing concurrency test going
flaky rather than by review: the plan is derived from reads outside the claim,
so a loser in a two-tab race could see the winner's freshly created account,
flip its plan, and answer `sign-in-required` when the truth was `accepted`.
`acceptInvitation` now re-reads the invitation's own state on that refusal and
prefers it — sound because the claim and the account creation commit in the
same transaction, so observing the account means a later read observes the
`acceptedAt` too. The integration file was run ten times standalone to confirm.

### The rest

- **The bookmarklet capture token could not be revoked** (MEDIUM). It was
  `HMAC(AUTH_SECRET, "capture:" + householdId)` — no storage, no rotation — and
  `/api/capture` is public and CSRF-exempt, so a removed member kept a working
  write credential for ever. `Household.captureKey` now salts the derivation and
  is rotated in the same transaction as any membership deletion. See §9.
- **Changing the login address needed no re-authentication** (MEDIUM). A
  borrowed session could move the address and then own the account through
  `forgot password`. It now requires the current password, records an
  `EMAIL_CHANGED` audit event, and notifies the old address — without advising a
  reset, which after the change would be mailed to whoever made it.
- **Unbounded allocation from a hostile page** (LOW). `image.ts` and
  `fetchPage.ts` buffered the whole body before checking the cap, so a host that
  omits `Content-Length` could exhaust memory from one pasted URL. Both now
  share one capped, cancelling reader.
- **The rate limiter logged the addresses it exists not to keep** (LOW). The
  counter table stores only HMACs precisely so the box never accumulates a list
  of addresses typed at a login form, and the throttle audit wrote them back in
  plaintext — in `detail` as well as `subjectEmail`. Both now carry a truncated
  HMAC fingerprint, which still dedupes per subject. The legitimate
  `subjectEmail` writers (invitations, membership changes, where the actor
  already knows the address) are unchanged.
- **The recipe-image redirect re-validates** (LOW). The stored `imageUrl` was
  checked by `resolvePublicUrl` when written, but DNS does not hold still, and
  this codebase re-validates every redirect hop elsewhere. It now re-checks
  before the 302 and 404s if the answer changed.

### Found while verifying, not by the review

Both `?next=` guards were bypassable. `/login` used
`startsWith("/") && !startsWith("//")` and `/open` used `/^\/(?!\/)/`, and
`/\evil.com` passes both and resolves to `https://evil.com/`, because a browser
reads a backslash as a path separator. `/open` is the one that matters: those
links sit in mail. Both now use `safeNextPath` (`src/lib/safeRedirect.ts`),
which resolves the candidate against the real origin and insists the answer is
still that origin, rather than pattern-matching the separators and encodings
that behave this way. This mattered more after the invitation fix than before
it, since the invite flow now routes existing accounts through `/login?next=`.

### Corrected after the gate

- **A missing backup destination no longer refuses to start.** The Phase 6
  startup check made `BORG_REPO` and `BORG_PASSPHRASE` fatal in production,
  which contradicted the rest of the app: the scheduler in
  `src/instrumentation.ts` treats unconfigured backups as "not an error — an
  instance can be run without backups" and idles, and the settings screen says
  the same. The check won, so a box with no Borg repository could not boot at
  all — an unbacked-up box became a box with no data to lose because it never
  ran. Backups are now off when `BORG_REPO` is unset. What stayed fatal is the
  incoherent case: once a repository is named, its passphrase must be present,
  not the public placeholder, and long enough to be worth having.

### Accepted, not fixed

- **`PATCH /api/account` answers `email-taken`**, which tells a signed-in caller
  whether an address has an account here. It is authenticated and rate-limited,
  and every alternative that still lets somebody understand why their change was
  refused leaks the same bit. Recorded rather than papered over.
- **Changing the login address does not sign other devices out.** Requiring the
  current password already blocks the bare-stolen-cookie case that made this
  worth fixing; a reset, which is the remedy for a stolen session, still signs
  every device out.

### Notes for whoever picks this up

- **`npm run lint` is not configured**, still. There is no ESLint dependency and
  no config file of any kind, so `next lint` drops into its interactive setup
  prompt and the plan's "formatting" step has no tooling behind it. **Decided:
  after Phase 6, not in it.** Standing a linter up now would mean landing a
  large, mechanical, unreviewed diff on top of the security work this gate just
  cleared, which is exactly the change you do not want adjacent to the one
  somebody might later need to audit. Nothing the review found would have been
  caught by a linter. When it is picked up, note that `next lint` is deprecated
  in Next 15 — the flat-config `eslint` + `eslint-config-next` route is the one
  that will still exist next year.
- The Phase 6 work, including the review fixes, is committed on
  `fix/receipt-upload`; no branch was pushed.
- **To get a database to verify against**, the scratch cluster used here lived
  in a temporary directory that does not survive; recreate one with:

  ```sh
  initdb -D /tmp/mp-pg -U postgres --auth=trust
  pg_ctl -D /tmp/mp-pg -o "-p 55432" -l /tmp/mp-pg.log start
  createdb -h 127.0.0.1 -p 55432 -U postgres mealplanner_scratch
  export DATABASE_URL="postgresql://postgres@127.0.0.1:55432/mealplanner_scratch"
  export AUTH_SECRET="anything-long-enough-for-the-startup-check"
  npx prisma migrate deploy && npm test
  ```

  Without `DATABASE_URL` the integration tests skip themselves and `npm test`
  still passes — which is convenient but means a green run proves less. The
  numbers quoted above are from a run *with* a database; `skipped 0` in the
  summary is how you tell the difference.

  Use a **separate** database for `prisma migrate diff --shadow-database-url`.
  Pointing it at the same database you just migrated resets it, and the next
  `migrate deploy` then fails with `P3005`.
- **`prisma migrate diff` reports no drift** between `prisma/schema.prisma` and
  the migration history. If you change the schema, re-check it.

## Exposure gate

Phase 6 has **passed**. The independent review is complete and every
high-severity finding is resolved; the two accepted risks are named above
rather than left implicit.

Verified on the current tree against a scratch PostgreSQL 16, from an empty
database: 23 migrations apply, `prisma migrate diff` reports no drift, **500
tests pass with none skipped** (run twice, plus the invitation integration file
ten times standalone to prove the concurrency fix is not flaky),
`tsc --noEmit` is clean, `next build` succeeds, and `npm audit` reports zero
vulnerabilities.

Two things the gate does *not* cover, because they change when the deployment
changes rather than when the code does. Neither blocks exposure, but both
should be true of the box on the day it is exposed:

- The manual two-household isolation pass and the browser CSP pass were run
  against the pre-review tree. The invitation, account and settings screens
  changed since. Re-walk the invite flow in a real browser — in particular an
  invitation to an address that already has an account, which now routes through
  `/login?next=` and is the one path a user-visible regression would hide in.
- SMTP is optional and is not a startup requirement, and the no-SMTP fallback
  now withholds the link for an address that already has an account. On a box
  with real users, configure SMTP: without it, those invitations cannot be
  delivered at all, which is the correct behaviour and an unhelpful one.

Public ingress is allowed only now that Phase 6 passes and HTTPS terminates at a trusted boundary. Tailscale Funnel can be that boundary, but `tailscale serve` alone is tailnet-only and cannot share the app with someone outside the tailnet. Until the gate passes, invite the friend to the tailnet and grant access through Tailscale ACLs/grants to only this service.
