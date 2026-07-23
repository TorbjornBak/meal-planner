# MealPlanner — v1 Design

A household web app that turns pasted weekly dinner plans into a shopping list and
tracks weekly grocery spending.

**Core loop:** paste a dinner plan → review parsed ingredients → generate a shopping
list → tick it off in the store → log what you paid → watch weekly spend.

---

## 1. Getting recipes in — paste-and-parse

- A **deterministic parser** (plain string handling, no LLM) reads a recipe into
  structured ingredients (name / quantity / unit) plus its stated serving count.
  Recipe pages have a rigid structure — a servings line, an ingredient block with
  one item per line, and usually embedded schema.org data — so no model is needed.
- **Three ways in, all feeding the same parser and the same review step:**
  - **Paste a URL** (the fast path) — the server fetches the page and parses it
    for you. Best-effort: it works for most sites that publish schema.org recipe
    data, which is the majority, but a site can refuse (bot walls, login, JS-only
    rendering). See §2b for the guarded fetch.
  - **Bookmarklet** — captures the page HTML from your own browser (where you're
    a logged-in, non-bot reader) and sends it in. Always works, because it's your
    real browser; it's the fallback when a URL fetch is blocked.
  - **Paste text** — copy the recipe text from anywhere and paste it.
- **A review-and-edit step is mandatory.** However a recipe came in, you eyeball
  and correct the parsed ingredients before they count toward anything. Bad parse
  = wrong list. URL and bookmarklet imports save a draft and drop you straight on
  the edit page to do this.

## 2. Recipe library — full curation

- Everything you paste is saved and accumulates into a reusable library.
- You can **browse, search, reuse** a past recipe in a new week, **tag favorites,
  rename, and delete**.
- The library is a first-class asset, not dead storage.

## 3. Meal plan — dinners only, as a calendar week

- A **calendar week** — one card per night, Monday to Sunday, with the date and
  today highlighted.
- Each night holds **any number of dinners** — add a second dish for a big
  night, or stack sides — each with its own photo and servings override.
- Nights can be left empty (leftovers / eating out).
- **Page back and forward through weeks.** Asking for a week creates it, so next
  week's plan exists the moment you look at it.
- Each night shows the recipe's photo (§2b) and links through to the cooking view.

## 2b. Recipe photos

- A recipe can carry **one photo**, shown on the cooking view, in the library
  list, and on its night in the calendar.
- **Captured recipes bring their own.** The page you captured already declares
  its photo (schema.org `image`, `og:image`, `twitter:image`); we read that URL
  out of the captured HTML and **download the image once**. Best-effort — a
  missing or unreachable photo never fails a capture.
- **Or add one yourself** from the edit page: upload from the device, or ask us
  to fetch the source page's photo for a recipe that predates this.
- Stored **as bytes in the database**, like receipt photos (§7) — not
  hotlinked. The app has to work offline over Tailscale (§10), and a hotlinked
  photo dies the day the source site reorganizes. Capped at 5 MB.
- The server reaches out to the open web in a few **guarded** spots: downloading
  a recipe photo by URL, fetching the recipe *page* for the paste-a-URL import
  (§1), and the "fetch from source" photo button for older recipes. All of them
  go through the same private-network guard (`resolvePublicUrl`), so neither a
  pasted URL nor a page-declared image URL can be used to probe the host's own
  network. The bookmarklet path still sends content straight from your browser.

## 4. Scaling — one household-size setting

- A single "household size" setting scales every recipe from its stated servings to
  your household size.
- **Per-dinner override** for guest nights or batch-cooking.
- Countable items round **up** to whole units; weight/volume scale precisely.

## 5. Shopping list — aggregate, with a pantry section

- The same ingredient across multiple dinners **merges into one line**.
- Units reconcile where clean; where they don't (e.g. "2 onions" + "150g onion"),
  **show both** rather than guess.
- **Pantry filter:** you maintain a list of "things we always have." Matched items are
  pulled out of the main actionable list into a separate **"Pantry — check you have
  these"** section — moved, never silently deleted, so you can verify stock when in
  doubt.
- Matching is **by ingredient name** against the pantry list. You curate the pantry
  list directly and can pull an item back onto the main list for a week if you've run
  out.

## 6. In-store — interactive checklist

- Tap to tick items off as you grab them.
- **State persists and is shared**, so two household phones stay in sync.

## 7. Spending capture — per-receipt total + photo

- Each shopping trip records: **date, store, total (typed in), and a receipt photo**
  stored in the database.
- No OCR, no line items.
- The spend ledger and the shopping list are **loosely coupled** — no item-level cost
  attribution.

## 8. Spending views — ledger + trend

- List of shopping trips with this-week / this-month sums.
- **Weekly-spend bar chart + rolling average.**
- Budget targets deferred to a later version.

## 9. Users — household, one shared password

- No individual accounts, no per-user data isolation.
- **One shared plan, one library, one ledger.**
- The shared password is mostly defense-in-depth, since Tailscale already gates access.

## 10. Hosting — home box via Tailscale (now)

- Runs on a home box, reachable over a private Tailscale tailnet from anywhere
  (including the store) — no port-forwarding, no dynamic DNS, no public exposure.
- HTTPS via `tailscale serve` on the MagicDNS `*.ts.net` name — no reverse proxy, no cert management.
- Each household member installs Tailscale once and joins the tailnet.
- **Possible VPS migration later** — kept cheap by building Dockerized from day one.

## 11. Backups — Borg → Hetzner Storage Box

- Nightly `borg create` of the Postgres dump + receipt-photo directory to a Hetzner
  Storage Box (deduplicated, encrypted, incremental), with `borg prune` for retention.
- Non-optional — it's the one real weakness of a home box.

## 12. Stack

- **Next.js (TypeScript, React)** full-stack.
- **Postgres + Prisma.**
- **Docker Compose:** app + Postgres. HTTPS via `tailscale serve` on the host.
- Recipe parsing is a **deterministic, in-process string parser** — no external
  services, no LLM, no API keys.

---

## Data model sketch

- **Recipe** — name, source, stated servings, tags/favorite flag, ingredient lines,
  and an optional photo (bytes + MIME type, plus the URL it came from).
- **Ingredient line** — name, quantity, unit (belongs to a Recipe).
- **WeekPlan** — week identifier + its dinner slots. Each slot pins a Recipe to a night
  (with an optional per-slot servings override and an ordering position); a night may
  hold several slots or none.
- **ShoppingList** — a persistent entity derived from a WeekPlan. Keyed by ingredient
  identity so it can be **diffed** against plan changes: surviving items keep their
  checked state, new ingredients arrive unchecked, removed ones drop off. Tracks
  per-item checked state.
- **PantryItem** — a name in the household's "always have" list.
- **ShoppingTrip / Receipt** — date, store, total, receipt photo.
- **Settings** — household size, shared password.

---

## Deferred (not in v1)

- Bulk or automated crawling of source sites — no crawler, no background jobs,
  no re-fetching on a schedule. Single-page import of a URL *you* paste is
  supported (§1); it's a best-effort fetch of one page you chose, with the
  bookmarklet as the fallback when a site blocks it.
- Receipt OCR / line-item spend and item-level cost attribution.
- Budget targets and over-budget alerts.
- Individual user accounts / multi-tenant isolation.
- Store-aisle grouping of the shopping list.
- All-meals planning (breakfast/lunch).
