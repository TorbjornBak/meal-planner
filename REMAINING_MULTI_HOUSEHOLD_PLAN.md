# Remaining multi-household and public-access plan

## Stopping point

Phases 1–5 are complete. Phase 6 implementation and operational verification
are complete; the independent standards/specification review and its release
blocking fixes are recorded below.

Phases 1–5:

- [x] Add households, memberships, household/platform roles, and deterministic migration of existing data.
- [x] Store an active household in each session and provide authorization helpers.
- [x] Require household ownership throughout plans, recipes, pantry, shopping, spending, settings, capture, dashboard, and weekly-digest queries.
- [x] Replace the account-shaped invitation with an invitation record, and add household administration.
- [x] Separate operating the installation from living in a household, and write down every intervention.

Keep the app behind **Tailscale Serve** for the friend trial. Do not enable Funnel or another public ingress until the remaining security phase is complete.

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

## Phase 6 — what remains

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
- [ ] **Independent standards and specification review**, resolving all
      high-severity findings. The first `/code-review` pass against the
      merge-base found unsafe production-startup gaps and a DNS rebinding gap;
      both are fixed, along with its documentation-boundary and mail-limit/audit
      findings. A clean follow-up review is the final gate.
- [x] **A backup restore rehearsal.** Installed Borg 1.4.5, ran the application's
      real `pg_dump` → encrypted `repokey-blake2` archive path against the
      scratch PostgreSQL database, extracted `mealplanner.sql`, restored it into
      a fresh database, and queried representative recipe, pantry, spending and
      settings data successfully.

### Notes for whoever picks this up

- **`npm run lint` is not configured.** It drops into an interactive ESLint
  setup prompt, so the plan's "formatting" step currently has no tooling behind
  it. Setting one up was out of scope for this pass; decide whether it belongs
  in Phase 6 or after.
- The Phase 6 work is committed on `fix/receipt-upload`; no branch was pushed.
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
  numbers quoted above are from a run *with* a database.
- **`prisma migrate diff` reports no drift** between `prisma/schema.prisma` and
  the migration history. If you change the schema, re-check it.

## Exposure gate

Phase 6 has **not** passed until the independent review above is complete.

Public ingress is allowed only after Phase 6 passes and HTTPS terminates at a trusted boundary. Tailscale Funnel can be that boundary, but `tailscale serve` alone is tailnet-only and cannot share the app with someone outside the tailnet. Until the gate passes, invite the friend to the tailnet and grant access through Tailscale ACLs/grants to only this service.
