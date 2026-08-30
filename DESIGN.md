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
- **Cooking mode** on a recipe holds the screen awake (Screen Wake Lock) while
  you cook, so the phone doesn't black out with wet hands. It's a toggle, off by
  default, and it's remembered between recipes.
- **Timers come out of the method text.** Every cook time in a step ("20-25
  minutter", "1 hour and 30 minutes", Danish or English) is a tap-to-start
  countdown, and a manual timer covers the steps that don't say. Several run at
  once, the alarm is a synthesised beep plus a vibration, and — like everything
  else — the reading is a deterministic parse, no LLM (§1, §12). Timers live in
  the open page only; nothing runs in the background.

## 3. Meal plan — dinners only, as a calendar week

- A **calendar week** — one card per night, Monday to Sunday, with the date and
  today highlighted.
- Each night holds **any number of dinners** — add a second dish for a big
  night, or stack sides — each with its own photo and servings override.
- Nights can be left empty (leftovers / eating out).
- **Dinners can be dragged from night to night.** A plan changes after it's
  made — a late meeting moves Thursday's stew to Saturday — and saying so should
  not mean deleting the dinner and searching the library for it again, which
  also loses its servings override (§4). Drag by the grip on the card: pointer
  events, so it works with a finger as well as a mouse, and the week auto-scrolls
  when you drag past the edge of the screen. The same move is on the arrow keys,
  since no keyboard has a drag gesture.
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

## 2c. Drinks — a second section in the library

- The library holds **dinners and drinks**, in two sections you switch between:
  coffee ratios, cordials, gløgg, the punch somebody makes at Christmas.
- **A drink is a recipe in every way that matters.** Same paste-and-parse (§1),
  same mandatory review, same ingredients, same method with working timers, same
  photo. It differs in one respect only: it isn't dinner.
- **The plan stays dinners only** (§3), so a drink never appears in the night
  picker and never goes on a night. Everything downstream follows from that:
  a drink has no "last cooked" week, and its ingredients don't reach the
  aggregated shopping list (§5) — coffee beans go on the list by hand, like
  kitchen roll.
- **Which it is, is a field, not a tag.** Tags are free text the household types,
  so "drink", "Drink" and "drinks" would all mean this and none of them could be
  relied on by the picker, which has to be *certain* before offering something as
  tonight's dinner. It's set in the review step and changed on the edit page like
  any other parsed field.
- **The wording follows the kind.** A stew serves four; a cortado makes one.

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

- Each shopping trip records: **date, store, total, and a receipt photo** stored
  in the database.
- **The total is read off the photo.** OCR runs on our own box — Tesseract
  compiled to WebAssembly, with the Danish language model vendored in
  `tessdata/` — so there is no service, no key, and nothing fetched at runtime.
  Attaching a photo fills the total in.
- It is a **suggestion, not an authority.** The amount lands in the total box
  for a human to confirm or overtype, next to the receipt line it was read
  from. Nothing reaches the ledger unread.
- Picking the number is **deterministic and label-driven**: lines are scored on
  what they call themselves, so "AT BETALE" wins and cash tendered, change and
  VAT lose. When no label survives OCR we fall back to the largest amount and
  say plainly that that's what we did.
- Still **no line items** — one total per trip.
- The spend ledger and the shopping list are **loosely coupled** — no item-level cost
  attribution.

## 8. Spending views — ledger + trend

- List of shopping trips with this-week / this-month sums.
- **Weekly-spend bar chart + rolling average.**
- Budget targets deferred to a later version.

## 9. Users — individual accounts, one shared household

- **Each member has their own account** — email address and password. Sign-in is
  per person, so access can be granted and revoked one member at a time, and
  email has somewhere to go (§9b).
- **Accounts gate entry; they do not partition data.** There is still **one
  shared plan, one library, one ledger**. Nobody has a private recipe box.
- **No roles.** A household is a handful of people who already share a kitchen;
  anyone who can sign in can invite and remove members, the same way anyone can
  tick off the shopping list.
- **Passwords** are hashed with **scrypt** from the Node standard library — no
  hashing dependency to keep patched, for the same reason parsing and OCR are
  in-process (§12). Minimum ten characters; length beats character-class rules.
- **Sessions are database rows**, not self-contained signed cookies, so signing
  out — or removing a member — takes effect on the very next request instead of
  whenever a cookie happens to lapse. The cookie holds a random token; only its
  hash is stored, so a database dump doesn't hand over live sessions.
- **Getting in when you can't:**
  - **Forgot password** emails a single-use link, good for one hour. Requesting
    one always reports the same thing whether or not the address is registered —
    the endpoint is unauthenticated, and a different answer would turn it into a
    way to test which addresses exist.
  - **Invitations** are the same machinery with warmer copy and a seven-day life.
    An invited member exists with no password until they choose one.
  - Resetting a password **signs out every device**, since a reset is the remedy
    for a stolen session as much as a forgotten password.
  - **First run:** a fresh instance with no accounts opens `/setup` to create the
    first one, and closes it permanently once an account exists.
- Tailscale (§10) is still the primary gate; accounts are the second factor.

## 9b. Weekly newsletter

- **One email a week** to each member who wants it: the **coming week's dinners**,
  night by night, and the **recipes added to the library** in the last seven days.
- It's a **nudge, not a report** — the empty nights are stated rather than
  omitted, and the call to action counts them ("Fill in the 4 empty nights").
- **A week with nothing on it isn't sent.** A weekly email that regularly says
  nothing is one people learn to ignore.
- **Sent over your own SMTP server**, not a mail API — no account to sign up
  for, no key to leak (§12).
- **The app schedules it**, on a timer started from Next's `instrumentation`
  hook. This began as host cron calling `POST /api/newsletter/send`, and the
  crontab turned out to be the least reliable part of the system: unversioned,
  missing from a rebuilt box, and silent when its command was wrong. The
  endpoint stays, for re-running a week by hand.
- **Due, not fired.** The schedule asks "should this week's digest have gone out
  by now?" rather than firing at an instant, so a box that was off at the send
  hour sends when it comes back, and a delivery that failed is retried on the
  next tick. A missed cron firing was simply lost.
- **The send hour is a wall clock** in a configured zone, so it doesn't move
  when the clocks do.
- Delivery is recorded per member per week, so a re-tick, a restart or a
  retried request can't send twice.
- **Every mail carries plain text alongside the HTML**, and a working
  **one-click unsubscribe** — both the footer link and the `List-Unsubscribe`
  header the mail client's own button uses. Unsubscribing only clears the digest
  opt-in; the account is untouched.

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
- Receipt OCR is **Tesseract in-process** (WebAssembly, vendored language
  model) for the same reason — it's a library, not a service (§7).

---

## Data model sketch

- **Recipe** — name, kind (dinner or drink, §2c), source, stated servings,
  tags/favorite flag, ingredient lines, and an optional photo (bytes + MIME type,
  plus the URL it came from).
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
- **User** — email, display name, scrypt password hash, newsletter opt-in (§9).
- **Session** — a signed-in browser: hashed token, owner, sliding expiry (§9).
- **AuthToken** — a single-use emailed link (reset / invitation), stored hashed,
  with an expiry and a spent-at marker (§9).
- **NewsletterSend** — one digest, one member, one week; the unique constraint is
  what makes the weekly send idempotent (§9b).
- **Settings** — household size.

---

## Deferred (not in v1)

- Bulk or automated crawling of source sites — no crawler, no background jobs,
  no re-fetching on a schedule. Single-page import of a URL *you* paste is
  supported (§1); it's a best-effort fetch of one page you chose, with the
  bookmarklet as the fallback when a site blocks it. The weekly digest's timer
  (§9b) is the one exception, and a narrow one: it fetches nothing and calls
  nobody, it only asks the database whether this week's mail is owed.
- Line-item spend and item-level cost attribution. Receipts are OCR'd for their
  total only (§7); nothing reads the individual products off them.
- Budget targets and over-budget alerts.
- Per-user data isolation / multi-tenancy. Accounts exist (§9), but everyone in
  the household still shares one plan, one library and one ledger.
- Third-party sign-in (Google, Apple). It would make an external service a hard
  dependency for reaching your own kitchen app, against §12 — and the tailnet's
  `*.ts.net` name (§10) can't satisfy either provider's domain-verification
  requirement anyway. Magic-link sign-in over our own SMTP, or passkeys, are the
  self-contained ways to drop the password; `AuthToken.purpose` already carries a
  `MAGIC_LINK` case so neither needs a migration.
- Store-aisle grouping of the shopping list.
- All-meals planning (breakfast/lunch).
