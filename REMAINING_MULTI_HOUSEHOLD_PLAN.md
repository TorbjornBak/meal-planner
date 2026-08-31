# Remaining multi-household and public-access plan

## Stopping point

Phases 1–4 are complete:

- [x] Add households, memberships, household/platform roles, and deterministic migration of existing data.
- [x] Store an active household in each session and provide authorization helpers.
- [x] Require household ownership throughout plans, recipes, pantry, shopping, spending, settings, capture, dashboard, and weekly-digest queries.
- [x] Replace the account-shaped invitation with an invitation record, and add household administration.

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
- [x] Add integration tests for expiry, replay, revocation, email mismatch, existing users, concurrent acceptance, and cross-household denial. — `src/lib/invitations.test.mjs` and `src/lib/invitations.integration.test.mjs`; the integration file skips without a database, and no database has been available to run it here.

Carried into Phase 6: accounts invited under the old scheme still hold a membership and a live `INVITE` `AuthToken`, and still finish through `/reset`. Removing that path is Phase 6's "remove obsolete invitation/reset paths".

## Phase 5 — platform administration

- [ ] Add a platform-admin screen for inviting people to create households and revoking pending invitations.
- [ ] Enforce platform-admin authorization in the API for SMTP diagnostics, backup status/setup/run, and other installation-wide settings; hiding UI controls is not sufficient.
- [ ] Keep platform admin separate from household access. Platform admins receive no routine access to recipes, plans, shopping, pantry, or spending unless they are explicitly household members.
- [ ] Add a narrow intervention view for household membership metadata and peer-admin recovery/removal. Record every intervention; do not provide routine household-content browsing.
- [ ] If promotion to platform admin is added, prevent platform admins from demoting themselves or another platform admin through the normal interface.
- [ ] Add authorization tests covering platform user, household admin, household member, and anonymous callers for every operational endpoint.

## Phase 6 — public-internet hardening

- [ ] Add persistent rate limits for login, password reset, invitation inspection/acceptance, and mail-sending endpoints. Key by both IP and normalized account/email where applicable.
- [ ] Add origin/CSRF protection to cookie-authenticated mutations and retain `SameSite`, `HttpOnly`, and production `Secure` cookies.
- [ ] Add security headers: a tested Content Security Policy, `frame-ancestors 'none'`, `nosniff`, a conservative referrer policy, and HSTS only after HTTPS is guaranteed.
- [ ] Fail production startup when `AUTH_SECRET`, `APP_URL`, database credentials, or cron/backup secrets are missing, weak, or left at example values.
- [ ] Audit public routes and remove obsolete invitation/reset paths. Ensure errors do not reveal whether an email address exists.
- [ ] Add audit records for invitations, membership changes, platform interventions, SMTP checks, backup actions, password changes, and repeated authentication failures.
- [ ] Review upload/capture size limits, outbound fetch protections (DNS/IP validation and redirect re-checking), dependency vulnerabilities, logging, retention, backup restore, and disaster recovery.
- [ ] Run migrations against a disposable PostgreSQL database, then run formatting, type checking, tests, production build, and a manual two-household isolation test.
- [ ] Obtain an independent standards and specification review and resolve all high-severity findings.

## Exposure gate

Public ingress is allowed only after Phase 6 passes and HTTPS terminates at a trusted boundary. Tailscale Funnel can be that boundary, but `tailscale serve` alone is tailnet-only and cannot share the app with someone outside the tailnet. Until the gate passes, invite the friend to the tailnet and grant access through Tailscale ACLs/grants to only this service.
