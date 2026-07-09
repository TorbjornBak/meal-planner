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
- **Docker Compose**: app + Postgres + Caddy, reachable over **Tailscale**.

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

- `docker compose up -d --build` brings up app + Postgres + Caddy.
- Provision an HTTPS cert with `tailscale cert <host>.<tailnet>.ts.net` and edit
  `Caddyfile` with your MagicDNS name (§10). Or drop Caddy and use
  `tailscale serve`.
- Migrations run automatically on container start (`prisma migrate deploy`).
- Schedule `scripts/backup.sh` nightly (§11).

## Status

This is a **scaffold**: the data model, config, deployment, and API surface are
in place, along with the core parsing / scaling / aggregation logic. Page UIs
are stubs marked with `TODO` pointing at the design section each implements.
