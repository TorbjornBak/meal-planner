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
- **Docker Compose**: app + Postgres, served over **Tailscale** via `tailscale serve`.

No third-party APIs or keys: recipe parsing is a deterministic string parser
(§1), not an LLM, and receipt OCR is Tesseract compiled to WebAssembly, running
in-process against a language model vendored in `tessdata/` (§7) — a library, not
a service. The server does fetch directly from a recipe's *own* source site — the
page, when you import by pasting a URL, and its photo — but that's a best-effort,
user-initiated fetch guarded against private-network addresses, not a service you
sign up for.

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
  recipeKind.ts             dinner or drink: the library's two sections (§2c)
  recipeCategory.ts         meat / fish / vegetarian / vegan (§2d)
  recipeSuggestions.ts      the dashboard's random dinners (§2e)
  scaling.ts                recipe scaling to household size (§4)
  shopping.ts               merge + pantry aggregation (§5)
  keys.ts                   ingredient-name normalization for merge/diff/pantry
  ocr.ts                    receipt photo → text, local Tesseract (§7)
  receiptTotal.ts           pick the total out of OCR'd receipt text (§7)
  spending.ts               weekly spend aggregation (§8)
  auth.ts                   accounts, sessions, emailed link tokens (§9)
  password.ts               scrypt password hashing (§9)
  currentUser.ts            the signed-in user inside a request (§9)
  mail.ts                   SMTP transport, your own server (§9, §9b)
  emailLayout.ts            dependency-free email HTML primitives
  emails.ts                 reset / invitation / password-changed templates (§9)
  newsletter.ts             weekly digest composition, pure + tested (§9b)
  weeklyDigest.ts           gathering and delivering the digest (§9b)
  prisma.ts                 Prisma client singleton
src/app/                  App Router pages (dashboard, plan, recipes,
                          shopping, spending, settings, login, setup, forgot,
                          reset/[token])
src/app/api/             Route handlers (parse, import, capture, recipes, plan,
                          shopping, pantry, trips, receipts/ocr, settings,
                          login, logout, setup, account, users, password/*,
                          newsletter/*)
src/middleware.ts        Gates every route behind a signed-in account (§9)
tessdata/                Vendored Tesseract language model for receipt OCR (§7)
scripts/backup.sh        Nightly Borg backup to a Hetzner Storage Box (§11)
```

## Local development

1. Copy env: `cp .env.example .env` and fill in `AUTH_SECRET`. The `SMTP_*`,
   `MAIL_FROM` and `APP_URL` values are optional locally — without them the app
   runs, it just can't send password resets, invitations or the weekly digest.
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

## Production (home box via Tailscale)

- `docker compose up -d --build` brings up app + Postgres. The app listens on
  `127.0.0.1:3000`.
- Expose it over HTTPS on the tailnet with `tailscale serve --bg 3000`
  (tailscaled runs on the host). No reverse proxy or cert management (§10).
- Migrations run automatically on container start (`prisma migrate deploy`).
- Schedule `scripts/backup.sh` nightly (§11).

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
setting to go and check. The most common cause on a home box is that **the mail
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
  https://box.your-tailnet.ts.net/api/newsletter/send
```

It returns a JSON report naming who it sent to and why it skipped anyone else.

## CI/CD (Forgejo Actions)

Both the Forgejo instance and its runner live on the same home server as the
app, so there is no registry round-trip over the network and nothing needs
inbound access.

- `.forgejo/workflows/ci.yml` — typechecks every push and PR outside `main`.
  Runs in a `node:22-bookworm` container (`runs-on: docker`).
- `.forgejo/workflows/deploy.yml` — on push to `main`: builds the image, pushes
  it to the Forgejo container registry tagged with the commit SHA and `latest`,
  syncs `docker-compose.yml` into `/srv/mealplanner`, restarts the stack, and
  polls `/login` until the app answers. Runs on the host (`runs-on: self-hosted`).

### One-time setup

1. **Runner in host mode.** Register a runner with the `self-hosted` and
   `docker` labels; the `self-hosted` label must map to `host` so deploy jobs
   use the host Docker daemon. The runner's user needs to be in the `docker`
   group, and `git`, `curl` and `node` must be on its PATH.
2. **Deploy directory.** `mkdir -p /srv/mealplanner` and put the production
   `.env` there (`AUTH_SECRET`, `POSTGRES_*`, and for email `SMTP_*`,
   `MAIL_FROM`, `APP_URL`, `CRON_SECRET`). It is never overwritten by a deploy —
   only `docker-compose.yml` is synced.
3. **Registry access.** Enable the Forgejo package registry, then in the repo
   settings add:
   - variable `REGISTRY_HOST` — the Forgejo host, e.g. `forgejo.example.ts.net`
   - secret `REGISTRY_TOKEN` — an access token with `write:package` scope
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
