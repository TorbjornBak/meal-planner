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

No external services: recipe parsing is a deterministic string parser (§1), so
there's nothing to call out to and no API key to manage.

## Project layout

```
prisma/schema.prisma      Data model (recipes, plans, lists, pantry, spend)
src/lib/                  Core logic:
  parse.ts                  deterministic recipe parsing, no LLM (§1)
  scaling.ts                recipe scaling to household size (§4)
  shopping.ts               merge + pantry aggregation (§5)
  keys.ts                   ingredient-name normalization for merge/diff/pantry
  auth.ts                   shared-password session (§9)
  prisma.ts                 Prisma client singleton
src/app/                  App Router pages (dashboard, plan, recipes,
                          shopping, spending, settings, login)
src/app/api/             Route handlers (parse, recipes, plan, shopping,
                          pantry, trips, settings, login)
src/middleware.ts        Gates every route behind the shared session
scripts/backup.sh        Nightly Borg backup to a Hetzner Storage Box (§11)
```

## Local development

1. Copy env: `cp .env.example .env` and fill in `HOUSEHOLD_PASSWORD` and
   `AUTH_SECRET`.
2. Start Postgres (either `docker compose up db` or your own instance) and point
   `DATABASE_URL` at it.
3. Install deps: `npm install`.
4. Apply the schema: `npm run prisma:migrate` (creates the initial migration).
5. (Optional) seed staples: `npx tsx prisma/seed.ts`.
6. Run: `npm run dev` → http://localhost:3000.

## Production (home box via Tailscale)

- `docker compose up -d --build` brings up app + Postgres. The app listens on
  `127.0.0.1:3000`.
- Expose it over HTTPS on the tailnet with `tailscale serve --bg 3000`
  (tailscaled runs on the host). No reverse proxy or cert management (§10).
- Migrations run automatically on container start (`prisma migrate deploy`).
- Schedule `scripts/backup.sh` nightly (§11).

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
   `.env` there (`HOUSEHOLD_PASSWORD`, `AUTH_SECRET`, `POSTGRES_*`). It is never
   overwritten by a deploy — only `docker-compose.yml` is synced.
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
