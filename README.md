# MealPlanner

A household web app that turns pasted weekly dinner plans into a shopping list
and tracks weekly grocery spending. See [DESIGN.md](./DESIGN.md) for the full v1
design.

**Core loop:** paste a dinner plan → review parsed ingredients → generate a
shopping list → tick it off in the store → log what you paid → watch weekly
spend.

## Stack

- **Next.js** (App Router, TypeScript, React) — full-stack.
- **Postgres + Prisma.**
- **Docker Compose**: app + Postgres, served publicly through Cloudflare and Caddy.

Cloudflare Turnstile is the app's one third-party API: every anonymous account-entry
form fails closed through it before the existing handler runs. Recipe parsing is
still a deterministic string parser (§1), not an LLM, and receipt OCR is Tesseract
compiled to WebAssembly, running in-process against a language model vendored in
`tessdata/` (§7) — a library, not a service. The server also fetches directly from a
recipe's own source site when asked, guarded against private-network addresses.

## Project layout

```
prisma/schema.prisma      Data model (recipes, plans, lists, pantry, spend)
src/lib/                  Core logic:
  parse.ts                  deterministic recipe parsing, no LLM (§1)
  html.ts                   extract a recipe from page HTML (JSON-LD/microdata)
  fetchPage.ts              guarded server-side fetch of a recipe page (§1)
  importRecipe.ts           parse HTML + download photo → saved draft (§1, §2b)
  image.ts                  download a recipe photo, private-network guarded (§2b)
  durations.ts              cook times out of a step, for the timers (§2)
  recipeKind.ts             dinner / side / dessert / drink, and what each
                            one may do: the library's sections (§2c)
  recipeCategory.ts         meat / fish / vegetarian / vegan (§2d)
  recipeSuggestions.ts      the dashboard's random dinners (§2e)
  scaling.ts                recipe scaling to household size (§4)
  shopping.ts               merge + pantry aggregation (§5)
  keys.ts                   ingredient-name normalization for merge/diff/pantry
  ocr.ts                    receipt photo → text, local Tesseract (§7)
  receiptTotal.ts           pick the total out of OCR'd receipt text (§7)
  spending.ts               weekly spend aggregation (§8)
  auth.ts                   accounts, sessions, emailed link tokens (§9)
  invitationService.ts      issue, accept, revoke and deliver invitations (§9)
  audit.ts                  durable security/operations event trail (§9c)
  platformAdmin.ts          pure platform-role authorization rules (§9c)
  csrf.ts                   origin checks for cookie-authenticated writes
  rateLimitPolicy.ts        rate-limit keys, windows and pure arithmetic
  rateLimit.ts              persistent counters and throttle auditing
  securityHeaders.ts        per-response CSP and browser hardening headers
  privateNetwork.ts         pure public/private IP classification
  password.ts               scrypt password hashing (§9)
  currentUser.ts            the signed-in user inside a request (§9)
  mail.ts                   SMTP transport, your own server (§9, §9b)
  backupSchedule.ts         which day's backup is owed, pure + tested (§11)
  borgConfig.ts             backup settings and the borg commands they build (§11)
  borgError.ts              a failed backup, as something to go and fix (§11)
  borg.ts                   running borg and pg_dump (§11)
  backups.ts                taking backups and recording what happened (§11)
  pgConnection.ts           DATABASE_URL, as pg_dump wants it (§11)
  wallClock.ts              wall-clock time in a named zone, for both schedules
  emailLayout.ts            dependency-free email HTML primitives
  emails.ts                 reset / invitation / password-changed templates (§9)
  newsletter.ts             weekly digest composition, pure + tested (§9b)
  weeklyDigest.ts           gathering and delivering the digest (§9b)
  retentionPolicy.ts        pure expiry rules for dead credentials
  retention.ts              daily expired-credential cleanup
  receiptPhoto.ts           safe receipt MIME types and upload limits
  startupConfig.ts          which env vars are missing/weak/example values,
                            pure + tested (Phase 6) — see "Startup checks" below
  prisma.ts                 Prisma client singleton
src/app/                  App Router pages (dashboard, plan, recipes,
                          shopping, spending, settings, login, setup, forgot,
                          reset/[token])
src/app/api/             Route handlers (parse, import, capture, recipes, plan,
                          shopping, pantry, trips, receipts/ocr, settings,
                          login, logout, setup, account, users, password/*,
                          newsletter/*, backup/*)
src/middleware.ts        Gates every route behind a signed-in account (§9)
tessdata/                Vendored Tesseract language model for receipt OCR (§7)
```

## Local development

1. Copy env: `cp .env.example .env` and fill in `AUTH_SECRET`. The `SMTP_*`,
   `MAIL_FROM` and `APP_URL` values are optional locally — without them the app
   runs, it just can't send password resets, invitations or the weekly digest.
   (The startup checks below only apply once `NODE_ENV=production`, so a
   half-filled `.env` is fine for `npm run dev` and `npm test`.)
2. Start Postgres (either `docker compose up db` or your own instance) and point
   `DATABASE_URL` at it.
3. Install deps: `npm install`.
4. Apply the schema: `npm run prisma:migrate` (creates the initial migration).
5. (Optional) seed staples: `npx tsx prisma/seed.ts`.
6. Run: `npm run dev` → http://localhost:3000.
7. First run has no accounts, so the app sends you to `/setup` to create one.
   Invite the rest of the household from Settings afterwards.

`npm test` runs the unit tests (Node's built-in runner, no framework — it reads
the TypeScript directly).

## Production (public deployment via Cloudflare and Caddy)

- Deploys are automatic: push to `main` and Forgejo Actions builds, publishes
  and restarts the stack (see [CI/CD](#cicd-forgejo-actions)). The commands
  below are for bootstrapping the box the first time, or for bringing it up by
  hand when CI is not an option.
- `docker compose up -d --build` brings up app + Postgres from this checkout.
  The app listens on `127.0.0.1:3000`.
- Put Caddy in front of the app and configure it for your public hostname. Point
  the hostname at the server through Cloudflare, and let Caddy terminate HTTPS
  (or use Cloudflare's origin certificate). Keep the app and Postgres ports
  bound to loopback; only Caddy needs to accept public traffic (§10).
  A minimal Caddyfile looks like this:

  ```caddy
  mealplanner.example.com {
      reverse_proxy 127.0.0.1:3000
  }
  ```
- Migrations run automatically on container start (`prisma migrate deploy`).
- Set up backups from Settings → Backups (§11). There is no crontab: the app
  takes them itself and tells you whether they worked.

## Startup checks (Phase 6)

In production (`NODE_ENV=production`), the app validates its own configuration
once at boot, before the schedulers above start, and **refuses to start** if
anything below is wrong — rather than booting clean and failing later on
whoever happens to trigger the broken thing first. `src/lib/startupConfig.ts`
is the pure rule table; `src/instrumentation.ts` is what calls it and, in
production, calls `process.exit(1)`. `npm run dev`, `npm test` and `next
build` are all unaffected — see below.

| Variable | Missing | Left at the example value | Present but weak |
| --- | --- | --- | --- |
| `AUTH_SECRET` | Fatal | Fatal | Fatal (< 20 characters) |
| `APP_URL` | Fatal | Fatal | Fatal if it doesn't parse as a URL, or isn't `https://` |
| `DATABASE_URL` | Fatal, including blank credentials | Fatal if either credential is still `mealplanner` | Fatal if it doesn't parse |
| `CRON_SECRET` | Fatal | Fatal | Fatal (< 20 characters) |
| `TURNSTILE_SECRET` | Fatal | — | — |
| `TURNSTILE_HOSTNAMES` | Fatal | — | Fatal if production includes `localhost` or `127.0.0.1` |
| `BORG_REPO` | — (backups simply off) | — | — |
| `BORG_PASSPHRASE` | Fatal **only if `BORG_REPO` is set** | Fatal if `BORG_REPO` is set | Fatal (< 20 characters) if `BORG_REPO` is set |

A few of these are worth spelling out:

- **`CRON_SECRET` is mandatory in production; a backup destination is not.**
  An unset `CRON_SECRET` leaves both bearer endpoints refusing requests, which
  is a required production operation unavailable. Backups are different: an
  unset `BORG_REPO` simply means the box does not back up, which is a judgement
  about what the data is worth and belongs to whoever runs it. Refusing to boot
  over it would leave an unconfigured box with no data to lose because it never
  starts. What *is* fatal is naming a repository and then guarding it badly —
  once `BORG_REPO` is set, `BORG_PASSPHRASE` must be present, not the public
  placeholder, and long enough to be worth having. Local development and tests
  may omit all of it; the boot check is production-only. The example secrets
  are public in this repository and are rejected too.
- **Default database credentials are treated as fatal, not a warning.**
  `docker-compose.yml` defaults `POSTGRES_USER`/`POSTGRES_PASSWORD` to
  `mealplanner`/`mealplanner` so a first `docker compose up` needs no setup —
  fine for local development, wrong once the Phase 6 exposure gate opens this
  to the public internet, since
  the credentials guarding every recipe, plan and receipt photo in the
  household would then be a published fact rather than a secret. The
  alternative (a warning) would let a deployment stay on them forever, since
  nothing would ever force the question again — so this refuses to start,
  at the cost of one restart after changing `POSTGRES_PASSWORD` and
  `DATABASE_URL` together.
- **A non-`https` `APP_URL` is fatal in production, not a warning**, for the
  same reason the security headers only send `HSTS` when `APP_URL` is
  `https`: the links this URL builds carry one-time tokens (password reset,
  invitation, unsubscribe) that are as good as a password while they're live,
  and the Phase 6 exposure gate already refuses public ingress until HTTPS
  terminates somewhere trusted — a production box without one hasn't met that
  gate yet.
- **A minimum length, not an entropy check.** `AUTH_SECRET`, `CRON_SECRET` and
  `BORG_PASSPHRASE` are all required to be at least 20 characters once they're
  checked at all. That's a floor, not a strength meter — measuring entropy
  honestly needs a dependency, and this app avoids one on principle (§12) —
  chosen to sit comfortably under `openssl rand -base64 32` (44 characters)
  while still catching a short, human-chosen string.
- **Never fires during `next build`.** Building the production image also runs
  `register()` while it prerenders pages, with `NODE_ENV` forced to
  `production` for the duration. `src/instrumentation.ts` checks
  `NEXT_PHASE === "phase-production-build"` and skips the whole thing then, so
  CI can build the image with no `.env` at all; the check only ever blocks a
  container that's actually about to serve traffic (`next start`).

A failing check prints every problem at once — not one per restart — as e.g.:

```
[startup] FATAL: AUTH_SECRET: AUTH_SECRET is not set. src/lib/auth.ts only discovers this when
something first needs it — a sign-in, a capture-token check, a newsletter tick — so an unset
secret lets the box boot and serve pages for hours before failing on whoever happens to trigger
it first. Set it to a long random string before starting: `openssl rand -base64 32`, pasted as
AUTH_SECRET="...".
[startup] FATAL: DATABASE_URL: DATABASE_URL is still using the example "mealplanner"/"mealplanner"
credentials from .env.example and docker-compose.yml's defaults. Set POSTGRES_USER and
POSTGRES_PASSWORD (and, if you assemble DATABASE_URL yourself rather than letting compose do it,
DATABASE_URL to match) to a real password before this box is reachable from anywhere but your own
public internet.
[startup] refusing to start: 2 problem(s) above must be fixed first (AUTH_SECRET, DATABASE_URL).
```

Outside production, every one of the same findings is still printed — as
`warning`, not `FATAL` — so a half-configured `npm run dev` box nags without
ever refusing to boot.

## Accounts and email (§9, §9b)

Each household member has their own account — email and password — but they all
share one plan, one library and one ledger. Accounts are how you sign in and
where email goes; they don't partition anything.

- **First run:** an instance with no accounts opens `/setup` to create the first
  one, then closes that route for good. Everyone else is invited from Settings.
- **Forgot a password:** `/forgot` mails a single-use link, good for one hour.
  Resetting signs out every device.
- **Email** goes through your own SMTP server. Set `SMTP_HOST`, `MAIL_FROM` and
  `APP_URL`; add `SMTP_USER`/`SMTP_PASS` if your relay wants authentication, and
  `SMTP_SECURE=true` on port 465. `APP_URL` has to be absolute — emails are read
  away from the app, so links can't be worked out from a request. Without these
  the app still runs; it just can't reset passwords or invite anyone.
- **Check it works** from Settings → Weekly email. *Test connection* connects and
  authenticates without sending, so a failure there separates "can't reach the
  server" from "message refused"; *Send me one now* does the full round trip.

### When email won't send

Both buttons, and a failed invitation, report the actual SMTP error with the
setting to go and check. The most common cause in this Docker deployment is that **the mail
server runs on the host while the app runs in a container** — `SMTP_HOST=localhost`
then means the container itself. Use the host's address, or add
`host.docker.internal` via `extra_hosts` in `docker-compose.yml`.

The others, in rough order of likelihood:

| What you see | Usually means |
| --- | --- |
| `ECONNREFUSED` | Nothing listening — wrong host/port, or the loopback trap above. |
| `ENOTFOUND` | The name resolves on the host but not inside the container. |
| `ETIMEDOUT` | Firewall, or the wrong port for the TLS mode. |
| `EAUTH` / `535` | Credentials rejected — some providers need an app-specific password. |
| self-signed certificate | Set `SMTP_TLS_REJECT_UNAUTHORIZED=false`, only for a server you control. |
| `wrong version number` | `SMTP_SECURE=true` belongs on 465; on 587 leave it false for STARTTLS. |
| `EENVELOPE` / `550` | `MAIL_FROM` isn't an address the server will send as. |

The full error is also in the app log (`docker compose logs app`).

### Weekly newsletter

One mail a week, looking both ways: ahead to the coming week's dinners and the
recipes added in the last seven days, and behind at what got cooked in the week
now ending and what the shopping came to — compared with the four weeks before
it, once there's enough ledger behind it to be worth comparing against (§7, §8).
The forward half leads, because it's the half somebody has to act on tonight.

The app schedules the digest itself — **there is no crontab to set up.** Friday
17:00 by default, which suits a weekend shop: the digest looks ahead to the
coming Monday, while there's still time to fill the empty nights in.

| Variable | Default | |
| --- | --- | --- |
| `DIGEST_SEND_DAY` | `FRI` | `MON`–`SUN`. |
| `DIGEST_SEND_HOUR` | `17` | `0`–`23`, a wall clock in `DIGEST_TIMEZONE`. |
| `DIGEST_TIMEZONE` | `Europe/Copenhagen` | Falls back to `TZ`. |
| `DIGEST_SCHEDULER` | `on` | `off` to stop sending entirely. |

Because the hour is a wall clock rather than a fixed UTC time, the mail doesn't
shift by an hour when the clocks change.

The schedule asks whether the week's digest *is owed*, not whether the hour has
just struck, and re-asks every 15 minutes until it isn't. So a box that was off
at 17:00 on Friday sends when it comes back, and a member whose delivery failed
— a mail server having a moment, say — is retried on the next tick rather than
missing the week. Delivery is recorded per member per week, so none of that can
send twice. A week with nothing ahead of it, nothing new in the library *and*
nothing behind it isn't sent at all.

On startup the log says what it's doing:

```
[digest] weekly digest scheduled for Friday 17:00 Europe/Copenhagen
```

If that line is missing, the scheduler didn't start — `docker compose logs app
| grep digest` will say why (no SMTP configured, or `DIGEST_SCHEDULER=off`).

`POST /api/newsletter/send` is still there for sending by hand, authenticated
with `CRON_SECRET`. Pass `?weekStart=YYYY-MM-DD` to re-run a specific week:

```sh
curl -sS -X POST -H "Authorization: Bearer <your CRON_SECRET>" \
  https://mealplanner.example.com/api/newsletter/send
```

It returns a JSON report naming who it sent to and why it skipped anyone else.

## Backups (§11)

Everything the household has is in Postgres — recipes, the plan, the ledger,
receipt photos and all. A single server is one dead disk away from losing it, so the
app takes a **Borg** backup every night, on its own schedule, and says on the
settings screen whether it worked. **There is no crontab to set up.**

Archives are deduplicated, compressed and encrypted before they leave the box.
A nightly full dump therefore costs about what changed that day.

### Setting it up

Settings → Backups walks through it, in this order:

1. **Point it at a repository.** Anywhere you can reach over SSH that has borg
   installed; a Hetzner Storage Box is the cheap one. Note the port and the
   `/./`, which means "relative to the login's home directory" — the two
   mistakes the screen will otherwise catch for you:

   ```
   BORG_REPO="ssh://u123456@u123456.your-storagebox.de:23/./mealplanner"
   ```

2. **Choose a passphrase.** It encrypts the repository, and it is the *only*
   thing that can decrypt it. The screen can generate one in your browser. Put
   it in `.env` as `BORG_PASSPHRASE` **and write it down somewhere that is not
   this box.** It is deliberately never stored in the database — that being the
   thing you would need it to restore.

3. Restart the app so it picks both up: `docker compose up -d`.

4. **Generate a key** on the settings screen and add the public key it shows to
   the backup host (on a Storage Box, its SSH-keys screen). The app keeps the
   private half in a volume; only the public half is ever shown.

5. **Create the repository**, then **Back up now**. Borg refuses to initialise
   over an existing repository, so that button can't overwrite anything.

From then on it runs at 03:00 in `BACKUP_TIMEZONE`, and the log says so at
startup:

```
[backup] nightly backup scheduled for 03:00 Europe/Copenhagen → u123456.your-storagebox.de
```

If that line is missing, `docker compose logs app | grep backup` will say why
(not configured, or `BACKUP_SCHEDULER=off`).

| Variable | Default | |
| --- | --- | --- |
| `BORG_REPO` | — | Where the archives go. Unset means no backups. |
| `BORG_PASSPHRASE` | — | Required once `BORG_REPO` is set. Keep a copy off the box. |
| `BACKUP_HOUR` | `3` | `0`–`23`, a wall clock in `BACKUP_TIMEZONE`. |
| `BACKUP_TIMEZONE` | `Europe/Copenhagen` | Falls back to `TZ`. |
| `BACKUP_SCHEDULER` | `on` | `off` to stop backing up on its own. |
| `BACKUP_KEEP_DAILY` / `_WEEKLY` / `_MONTHLY` | `7` / `4` / `6` | Retention. |

Like the digest, the schedule asks whether a backup **is owed** rather than
whether the hour has struck, and re-asks every 15 minutes. A box that was off at
03:00 backs up when it comes back, and a failed attempt is retried within the
hour instead of being written off until tomorrow.

`POST /api/backup/run` takes one by hand, with `CRON_SECRET` instead of a
session, for anyone who'd rather drive it from the host:

```sh
curl -sS -X POST -H "Authorization: Bearer <your CRON_SECRET>" \
  https://mealplanner.example.com/api/backup/run
```

### Restoring

The app container has borg, the key and the settings already, so a restore from
the box is three commands:

```sh
docker compose exec app borg list
docker compose exec app borg extract --stdout ::mealplanner-2026-08-30T01-00-00Z mealplanner.sql > mealplanner.sql
docker compose exec -T db psql -U mealplanner -d mealplanner < mealplanner.sql
```

The dump is plain SQL, taken with `--clean --if-exists`, so it restores over the
database that's already there and needs nothing but `psql`.

**If the box itself is gone**, you need two things that must live somewhere
else: the passphrase, and a way to log in to the backup host now that this
box's key is gone (for a Storage Box, the account password). With those, borg on
any machine reads the archives — the encryption key is stored inside the
repository, not on the box.

### When a backup won't run

The settings screen reports the actual error with the setting to go and check.
The common ones:

| What you see | Usually means |
| --- | --- |
| `Permission denied (publickey)` | The public key isn't installed on the backup host yet. |
| `Connection refused` on port 22 | A Storage Box listens on **23**. |
| `Repository does not exist` | Press *Create the repository*. |
| `passphrase … is incorrect` | `BORG_PASSPHRASE` changed. Put the old value back — a new one doesn't re-encrypt anything, it just stops the archives opening. |
| `Failed to create/acquire the lock` | A run was interrupted. `docker compose exec app borg break-lock`. |
| `borg: not found` | The container predates backups. `docker compose up -d --build`. |

## CI/CD (Forgejo Actions)

Pushing to `main` is the deploy: the workflow builds the image, publishes it
and restarts the stack. Nothing is deployed by hand.

Forgejo runs on the repository server, but **the runner belongs on the box the
app runs on** — the deploy job writes to `/srv/mealplanner`, talks to
that host's Docker daemon and polls `127.0.0.1:3000`, none of which mean
anything anywhere else. The runner polls Forgejo outbound, so nothing needs
inbound access.

- `.forgejo/workflows/ci.yml` — typechecks every push and PR outside `main`.
  Runs in a `node:22-bookworm` container (`runs-on: docker`).
- `.forgejo/workflows/deploy.yml` — on push to `main`: builds the image, pushes
  it to the Forgejo container registry tagged with the commit SHA and `latest`,
  syncs `docker-compose.yml` into `/srv/mealplanner`, restarts the stack, and
  polls `/login` until the app answers. Runs on the host (`runs-on: self-hosted`).

### One-time setup

1. **Runner in host mode,** installed on the app host. Create it in the web UI
   (repo Settings → Actions → Runners → *Create new runner*), which hands back a
   UUID and a secret; put those in the runner's config under
   `server.connections` — the `forgejo-runner register` subcommand is deprecated
   as of runner v13. Labels go in the same file:

   ```yaml
   runner:
     labels:
       - docker:docker://node:22-bookworm
       - self-hosted:host
   ```

   `self-hosted` must be the `host` type so deploy jobs use the host Docker
   daemon. The runner's user needs to be in the `docker` group, and `git`,
   `curl` and `node` must be on its PATH.
2. **Deploy directory.** `mkdir -p /srv/mealplanner` and put the production
   `.env` there (`AUTH_SECRET`, `POSTGRES_*`, and for email `SMTP_*`,
   `MAIL_FROM`, `APP_URL`, `CRON_SECRET`). It is never overwritten by a deploy —
   only `docker-compose.yml` is synced.
3. **Registry access.** Enable the Forgejo package registry, then in the repo
   settings add:
   - variable `REGISTRY_HOST` — the Forgejo host, e.g. `registry.example.com`
   - secret `REGISTRY_TOKEN` — an access token with `write:package` scope

   The image reference is lowercased in the workflow before use: Docker refuses
   a tag with uppercase in it, and the repository owner has capitals.
4. **Existing data.** The compose project is pinned to `name: mealplanner`, so
   the Postgres volume stays `mealplanner_pgdata`. If your current stack was
   started from a directory with a different name, rename the existing volume
   before the first deploy or Postgres will come up empty.

### Rollback

Every build is tagged with its commit SHA:

```sh
cd /srv/mealplanner
APP_IMAGE=<registry-host>/<owner>/meal-planner:<sha> docker compose up -d
```

## Status

This is a **scaffold**: the data model, config, deployment, and API surface are
in place, along with the core parsing / scaling / aggregation logic. Page UIs
are stubs marked with `TODO` pointing at the design section each implements.
