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
  - **Bookmarklet** — hands the current page URL to MealPlanner's URL import
    screen. This avoids cross-origin requests from the recipe site and saves
    copy-paste, while keeping the same guarded server-side fetch as the fast path.
  - **Paste text** — copy the recipe text from anywhere and paste it.
- **A review-and-edit step is mandatory.** However a recipe came in, you eyeball
  and correct the parsed ingredients before they count toward anything. Bad parse
  = wrong list. URL and bookmarklet imports save a draft and drop you straight on
  the edit page to do this.
- **Cancelling a fetched recipe throws it away.** A URL import has to be saved
  before you can review it — the page has already been fetched and parsed — but
  it isn't yours until you say so. Cancelling that first review deletes the
  draft rather than leaving an unreviewed recipe in the library.

## 2. Recipe library — full curation

- Everything you paste is saved and accumulates into a reusable library.
- You can **browse, search, reuse** a past recipe in a new week, **tag favorites,
  rename, and delete**. Deleting is offered both in the library list and at the
  bottom of the edit page — the editor is usually where you find out a recipe
  isn't worth keeping. It asks first, and says how many planned nights go with
  it, because the dinner slots cascade away too.
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
- Each night holds **any number of dinners and sides** (§2c) — a second dish for
  a big night, the salad that goes with the roast — each with its own photo and
  servings override. "Dinners only" is about the meal the app plans, not about
  how many things are on the table: breakfast and lunch are still out, and so are
  drinks and desserts, which never reach a night at all.
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
- **Imported recipes bring their own.** The fetched page declares its photo
  (schema.org `image`, `og:image`, `twitter:image`); we read that URL out of the
  HTML and **download the image once**. Best-effort — a missing or unreachable
  photo never fails an import.
- **Or add one yourself** from the edit page: upload from the device, or ask us
  to fetch the source page's photo for a recipe that predates this.
- Stored **as bytes in the database**, like receipt photos (§7) — not
  hotlinked. The app has to work when temporarily offline (§10), and a hotlinked
  photo dies the day the source site reorganizes. Capped at 5 MB.
- The server reaches out to the open web in a few **guarded** spots: downloading
  a recipe photo by URL, fetching the recipe *page* for the paste-a-URL import
  (§1), and the "fetch from source" photo button for older recipes. All of them
  go through the same private-network guard (`resolvePublicUrl`), so neither a
  pasted URL nor a page-declared image URL can be used to probe the host's own
  network. The bookmarklet enters through this same guarded URL path.

## 2c. Kinds — sections in the library

- The library holds **dinners, sides, desserts and drinks**, in sections you
  switch between: the mains, the salads and potatoes that go beside them, the
  cakes, and the coffee ratios and gløgg.
- **Each of them is a recipe in every way that matters.** Same paste-and-parse
  (§1), same mandatory review, same ingredients, same method with working
  timers, same photo. They differ in one respect only: what the household does
  with them.
- **Two questions follow from the kind, and they are not the same question.**
  - *Can it go on a night?* Dinners and sides. A meal is the roast and the salad
    — cooked the same evening, bought for together — so a side reaches the plan
    (§3) and through it the aggregated shopping list (§5), exactly like a dinner,
    and gets a "last cooked" week like one too.
  - *Is it an answer to "what shall we have?"* (§2e) Dinners only. The dashboard
    is asking what the meal **is**; a card coming back with two stews and a green
    salad has answered a question nobody asked. You reach for a side once you
    know what it is going next to.
- **Drinks and desserts stay off the plan entirely**, so neither ever appears in
  the night picker, neither has a "last cooked" week, and neither reaches the
  shopping list — coffee beans and vanilla pods go on the list by hand, like
  kitchen roll (§5, manual items).
- **Which it is, is a field, not a tag.** Tags are free text the household types,
  so "drink", "Drink" and "drinks" would all mean this and none of them could be
  relied on by the picker, which has to be *certain* before offering something as
  tonight's dinner. It's set in the review step and changed on the edit page like
  any other parsed field.
- **Nothing was backfilled.** The salads and cakes already filed as dinners stay
  filed as dinners until somebody re-files them; only the household knows which
  ones they are, and guessing from a name is the invented claim §2d refuses to
  make about categories.
- **The wording follows the kind.** A stew serves four; a cortado makes one.
- **The picker names what isn't a main.** A side in the night picker's results
  carries a small "Side" tag, because "Grøn salat" between two stews should read
  as the side it is.

## 2d. Categories — what a recipe is made of

- Every recipe can say what it is: **meat, fish, vegetarian or vegan**. One
  axis — what's at the centre of the plate — and one value per recipe, because
  that is the shape of the question: "we had fish on Monday" rules out a night,
  it doesn't rule out an ingredient.
- **Meat covers poultry and fish covers shellfish.** A household planning a week
  thinks "meat, fish, or neither", and splitting the chicken out would make the
  commonest category two decisions instead of one. The boundaries are in each
  filter's tooltip rather than in four more categories.
- **Vegan counts as vegetarian, and not the other way round.** Someone filtering
  for vegetarian is naming what they won't eat, so hiding the dal because it
  clears a higher bar is the kind of wrong that stops people trusting a filter.
  The implication runs one way only: asking for vegan and being handed an
  omelette is the failure the field exists to prevent.
- **Which it is, is a field, not a tag** — the same reasoning as §2c, and more
  of it. Tags are free text, so "veggie", "Vegetarian" and "vegetar" would all
  mean this and none could be relied on. The dashboard offers a recipe *as*
  vegetarian (§2e); a filter answering that from free text will eventually put a
  ragù in front of someone who asked for none.
- **Nothing was backfilled, and nothing is guessed.** Every recipe that predates
  the field reads "not said", and stays that way until somebody sets it. There
  is no honest way to infer it: reading the ingredient lines finds "kylling"
  inside "kyllingebouillon" and files a soup as meat, or misses the fish sauce
  and calls a curry vegan. An invented dietary claim is worse than an absent
  one. (This is also §12 — no LLM, and no heuristic pretending to be one.)
- **Set in the review step, changed on the edit page**, like any other parsed
  field. The library filters on it, and its **"Not said"** filter is how the
  backlog of unfiled recipes gets found and worked through — a filter nobody can
  see is one nobody fixes.

## 2e. "What shall we have?" — random dinners on the dashboard

- The dashboard offers **three dinners from the library, at random**, with a
  **shuffle** button and the category filters from §2d.
- **It answers the question that comes before a search.** The library can
  already find a cod recipe (§2); this is for the late afternoon when nothing is
  decided, which is the harder half and the reason the same eight dinners come
  round for years. The staleness sort (§2) attacks it from the other side, but
  that is a question you have to think to ask — this one is just there.
- **Random, not ranked.** A recommender would have to decide what makes a dinner
  good tonight, which this app cannot know and would need an LLM to fake (§12).
  Three at random out of a shelf you chose every item of is a good enough
  answer, and — unlike a score derived from your own cooking history — one you
  can explain.
- **Dinners only, and nothing already on the week.** A drink and a dessert can't
  go on a night at all (§3), so neither is ever offered — and neither is a side,
  which can: the card is asking what the meal is, not what goes beside it (§2c).
  Nor is a recipe already booked for this week: it's the one thing on the shelf
  that definitely isn't an answer to "what else?", and taking the offer would put
  it on the week twice.
- **The shuffle avoids what's on screen.** Drawing uniformly every press means a
  small library hands you two of the same three back, and a button that looks
  like it didn't work is worse than no button. When there aren't enough unseen
  dinners to fill the card it tops up from the rest rather than coming back
  short.
- **One press to plan it.** Each suggestion carries "Add to <night>" for the
  first free night of the week, and says which. The card doesn't rearrange
  itself when you take one — a suggestion that vanishes as you accept it leaves
  you wondering whether it landed.

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

## 9. Users — individual accounts, households as the unit of privacy

- **Each member has their own account** — email address and password. Sign-in is
  per person, so access can be granted and revoked one member at a time, and
  email has somewhere to go (§9b).
- **A household owns the data.** Every plan, recipe, pantry item, shopping list
  and receipt belongs to exactly one household; a household is the shared
  kitchen, and nothing crosses between two of them. Inside one there is still
  **one shared plan, one library, one ledger** — nobody has a private recipe box
  from the people they cook with.
- **An account may belong to several households**, through a membership. A
  browser acts in one at a time: the choice lives on the session row, so
  removing somebody's membership stops them acting in that household on their
  very next request, and a switcher appears only for the accounts that need one.
- **Two kinds of role, deliberately unconnected.** A **household role**
  (member / admin) says what you may do inside one kitchen. A **platform role**
  says whether you may operate the installation — SMTP, backups, inviting new
  households. Administering the box grants no routine access to anybody's
  dinners; a platform admin who wants to see a household's plan has to be a
  member of it.
- **Passwords** are hashed with **scrypt** from the Node standard library — no
  hashing dependency to keep patched, for the same reason parsing and OCR are
  in-process (§12). Minimum ten characters; length beats character-class rules.
- **Sessions are database rows**, not self-contained signed cookies, so signing
  out — or removing a member — takes effect on the very next request instead of
  whenever a cookie happens to lapse. The cookie holds a random token; only its
  hash is stored, so a database dump doesn't hand over live sessions.
- **Legacy bookmarklets used a capture token that isn't a session.** Newly
  generated bookmarklets navigate to the signed-in URL-import page instead,
  but `/api/capture` remains temporarily for already-installed bookmarklets.
  Its cross-origin request arrives without a cookie, so it
  carries a token derived per household instead. That token used to be a pure
  function of `AUTH_SECRET` and the household id, which made it unrevocable:
  somebody removed from a household kept a working write credential for it for
  ever, and the only remedy was rotating `AUTH_SECRET` and signing out the whole
  installation. The household now stores a `captureKey` that is mixed into the
  derivation and **rotated whenever anybody loses access**, in the same
  transaction that deletes the membership. Rotation invalidates the bookmarklet
  for everyone still in the household, which is the right trade: a shared
  credential cannot be revoked for one holder, and a stale legacy bookmarklet is an
  annoyance where a live one held by somebody who was removed is not.
- **Getting in when you can't:**
  - **Forgot password** emails a single-use link, good for one hour. Requesting
    one always reports the same thing whether or not the address is registered —
    the endpoint is unauthenticated, and a different answer would turn it into a
    way to test which addresses exist.
  - **First run:** a fresh instance with no accounts opens `/setup` to create the
    first one, and closes it permanently once an account exists.
  - Resetting a password **signs out every device**, since a reset is the remedy
    for a stolen session as much as a forgotten password.
  - **Changing the login address asks for the current password**, and tells the
    old address it happened. The address is what `forgot password` mails, so a
    session that can silently move it is a session that can take the account
    permanently — change the address, then use the ordinary recovery flow and
    lock the real owner out of their own. The notice deliberately does not
    advise a password reset the way the password-changed notice does: once the
    address has moved, a reset would be mailed to whoever moved it.
- **Invitations are the only way in**, and they are records rather than
  side effects. There is no open sign-up.
  - An invitation is a **hashed token, bound to one normalized address,
    single-use, seven days**. Forwarding the link to somebody else gets them a
    refusal, not a household.
  - **Nothing is created until it is accepted.** Under the old scheme the
    account and the membership were made the moment the link was sent, which
    made a person who never answered indistinguishable from a member who had
    simply never logged in — already inside a private roster, and impossible to
    withdraw. Now the offer and the membership are different things, and only
    the offer exists up front.
  - **Issuing a replacement revokes the previous unused one**, so "resend"
    leaves exactly one live credential rather than one per copy of the mail.
  - A **household invitation** adds the invitee to an existing household as one
    of its admins, and is a household admin's to send. A **platform invitation**
    creates a *new* household with the invitee as its first admin, and is the
    platform admin's — it is the thing that grows the installation.
  - An address that **already has an account signs in to accept**, and its
    password is still never touched. The rule here used to be that opening the
    link proved what a reset link proves. That reasoning was wrong in two
    places: a reset link only ever goes to the mailbox, whereas an invitation
    link is *also* handed back to the inviter when the box has no SMTP relay,
    and a reset ends by replacing the password rather than by handing over a
    session. So accepting anonymously let anyone who could issue an invitation
    mint a session for any address that already had an account — a household
    admin could take over a platform admin by inviting them. Both plans that
    resolve to an existing account now require a session for that same address
    (`sign-in-required`); only the plan that creates the account accepts from a
    signed-out browser, because there is no account there yet for a session to
    prove control of. What has *not* come back is asking an existing user for a
    new password: making somebody reset a working password in order to join a
    second kitchen is how you teach them that a mailed link means "type your
    password".
  - **Admins are equals**: a household admin may remove a member, but not
    remove or demote another admin. Two people who share a kitchen and have
    fallen out should end up talking, not racing to click first.
- The HTTPS reverse proxy is the network boundary; accounts are the second
  factor.

## 9b. Weekly newsletter

- **One email a week** to each member who wants it, looking both ways:
  - **Ahead** — the **coming week's dinners**, night by night, and the **recipes
    added to the library** in the last seven days.
  - **Behind** — **what got cooked** in the week now ending, and **what the
    shopping came to**, against the four weeks before it.
- The forward half is a **nudge, not a report** — the empty nights are stated
  rather than omitted, and the call to action counts them ("Fill in the 4 empty
  nights"). It leads, because it's the half somebody has to act on tonight.
- The backward half **is** a report, and sits below a rule. The plan and the
  ledger (§7, §8) always knew what the week held and cost; you just had to go and
  look, and nobody opens a spending page on a Friday. Arriving unasked is the
  only way that number gets seen.
- **It reports the week you just lived through**, not the last complete one. The
  mail goes out Friday evening, so the two nights still to come are counted as
  they fall rather than held back a week — by which time nobody remembers the
  week anyway.
- **The comparison is only drawn when there's something to compare with.** Four
  weeks of ledger, of which at least two contain a shop; anything younger would
  be arithmetic about the install date. A week with no shop logged says so — that
  nudge is worth having — but a household that has never used the ledger is never
  told about the ledger.
- **A week with nothing on it isn't sent.** A weekly email that regularly says
  nothing is one people learn to ignore. Last week's cooking and spending count
  as something: a household that cooked five dinners and simply hasn't planned
  next week yet is the one with the most to read.
- **One digest per household, not per person.** Somebody who cooks in two
  kitchens gets two mails about two different weeks, so the opt-in lives on the
  membership and the one-click unsubscribe in a footer silences the household
  whose footer it was — the token is signed over the member *and* the
  household, so a link from one can't be edited into silencing the other.
- **Every link in the mail selects its household first**, through `/open`.
  Otherwise a reader who belongs to two would land in whichever one their
  browser was last acting in, seeing another kitchen's week under this one's
  subject line with nothing to say so.
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

## 9c. Platform administration — operating the box, not reading the kitchens

- **Two jobs, two roles, no overlap.** A household admin runs one kitchen. A
  **platform admin** runs the installation: the SMTP relay, the backup
  repository, and the invitations that let a new household exist at all.
  Neither implies the other, and the platform admin's powers stop dead at the
  door of any household they are not a member of.
- **Operational endpoints are gated on the platform role, not on having a
  login.** SMTP diagnostics and every backup route used to accept any signed-in
  account. On a one-household box that was nearly true; with two households it
  means somebody from another kitchen can read the state of a backup
  repository and the real text of an SMTP error. Hiding the buttons is not the
  fix — the check is in the route (`guardOperational`), and the settings screen
  merely stops drawing controls that would now be refused.
- **`CRON_SECRET` is a door for one operation, not a role.** A host script may
  present it to run a backup. It does not open the admin screens: a shared
  secret drives a known job, it does not get to browse households.
- **The intervention view is deliberately narrow.** A platform admin can see,
  for any household: its name, when it was created, who is a member, their
  role, when they joined and when they last signed in. That is all. No recipe,
  no plan, no shopping list, no receipt, no total. The two things they may
  *do* are change somebody's household role and remove somebody from a
  household.
- **It exists because the peer-admin rule is right but incomplete.** Household
  admins are equals and cannot demote or remove one another (§9), which stops
  two people racing each other out of a shared kitchen — but it leaves a
  deadlocked household, or one whose only admin has lost their mailbox, unable
  to fix itself. Somebody outside has to be able to act. A household with
  members but no admin is flagged on the screen, since that is the state the
  whole view is for.
- **A platform admin may not demote a household's last admin** — that would
  manufacture the very stranded household this repairs. They *may* remove the
  last member, because that is how a household is wound up, and refusing it
  would strand abandoned households on the box for ever.
- **Every intervention is written down.** `AuditEvent` records who did what, to
  which household, to whom, as a sentence composed where the facts were still
  in scope. Each row stores the actor's address, the household's name and the
  subject's address as **snapshots** beside the foreign keys, and the keys null
  out rather than cascade: an audit trail that empties itself when an account
  is deleted is not an audit trail, and the moment anybody wants to read one is
  precisely the moment somebody has been removed.
- **The trail is readable by the people who write it**, which is weaker than
  shipping it off the box and is the right amount here. The claim being made is
  that an intervention cannot happen *silently*, not that it is unforgeable by
  somebody holding the database password.
- **Promotion to platform admin is not offered anywhere.** The first account
  created at `/setup` is one; nothing in the interface makes another. The rule
  that would govern it — no demoting yourself, no demoting a peer — is written
  down in `platformRoleChangeRefusal` and tested, so the day a button appears
  it starts out right, but no button exists today.

## 10. Hosting — public server via Cloudflare and Caddy (now)

- Runs on a public server (for example, a Hetzner VPS) with Docker Compose.
- Cloudflare provides DNS and optional edge protections; Caddy on the server
  terminates HTTPS and proxies the public hostname to the app's loopback port.
- Postgres and the app's direct port remain bound to loopback. Only Caddy's
  HTTPS listener is exposed publicly, and its forwarded host is the trusted
  boundary used by the app's origin and rate-limit checks.
- The deployment is portable: moving to another server changes the host and
  DNS records, not the application architecture.

## 11. Backups — Borg, taken by the app

- Nightly `borg create` of the Postgres dump to a repository over SSH — a Hetzner
  Storage Box is the cheap one — deduplicated, encrypted and incremental, with
  `borg prune` for retention and `borg compact` to actually free what it drops.
- **Non-optional** — it's the one real weakness of a home box. Everything the
  household has is in that database, receipt photos included (§7).
- **The app takes them**, on the timer started from Next's `instrumentation`
  hook (§9b). This began as `scripts/backup.sh` in the host's crontab, which is
  the arrangement §9b had already thrown out for the weekly digest: unversioned,
  missing from a rebuilt box, silent when wrong. It is a worse arrangement for
  backups than it was for mail — a digest that stops arriving is noticed by five
  people on Friday; a backup that stops running is noticed once, on the day the
  disk dies.
- **Due, not fired.** The schedule asks which day's backup should exist by now,
  not "is it 03:00?", so a box that was off at three backs up when it comes
  back, and a failed attempt is retried within the hour. A missed cron firing was
  simply lost. The hour is a wall clock in a configured zone, so it doesn't move
  when the clocks do.
- **Every attempt is recorded**, successes and failures alike, and the settings
  screen shows the last one in a sentence. "Backed up 6 hours ago" is the whole
  point: backups fail silently by nature, and a household that can see the answer
  finds out on a Tuesday rather than on the worst day of the year.
- **Set up from the settings screen**, in the order it's actually done: point at
  a repository, choose a passphrase, install a key, create the repository, take
  the first backup. The app generates its own SSH key and shows the public half
  to paste into the storage box, so nobody has to find their way into a container
  to run `ssh-keygen`. Failures come back as a sentence and the setting to go and
  change, the way SMTP failures do (§9).
- **The dump is streamed into borg uncompressed**, not gzipped first: borg
  deduplicates by content-defined chunking, and pre-compressing turns a one-row
  change into a fresh copy of the whole database every night. Nothing is staged
  on disk either — writing a copy of the database to the box whose disk you're
  hedging against is both the slow option and the one that fails when it matters.
- **A truncated dump is never left behind.** If pg_dump dies halfway, borg sees a
  clean end of stream and writes a valid archive holding half a database — so the
  dump's exit code is checked and a bad archive is deleted. A backup that failed
  is recoverable; one that lies is not.
- **The passphrase lives in the environment, never in the database.** It is the
  only thing that can decrypt the archives, and keeping it inside the thing being
  backed up would make them unreadable exactly when they were needed. Encryption
  is `repokey`, so the key travels in the repository and the passphrase alone
  restores from any machine.

## 12. Stack

- **Next.js (TypeScript, React)** full-stack.
- **Postgres + Prisma.**
- **Docker Compose:** app + Postgres. HTTPS via Caddy on the host, with the
  public hostname managed through Cloudflare.
- Recipe parsing is a **deterministic, in-process string parser** — no external
  services, no LLM, no API keys.
- Receipt OCR is **Tesseract in-process** (WebAssembly, vendored language
  model) for the same reason — it's a library, not a service (§7).

---

## Data model sketch

- **Recipe** — name, kind (dinner / side / dessert / drink, §2c), category (what it's made of,
  nullable, §2d), source, stated servings, tags/favorite flag, ingredient lines,
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
- **Household** — the private collection of plans, recipes, pantry, shopping and
  spending that a kitchen shares. Every aggregate root above carries mandatory
  household ownership (§9).
- **HouseholdMembership** — which account may act in which household, in what
  household role, and whether that household's weekly mail reaches them (§9b).
- **User** — email, display name, scrypt password hash, platform role (§9).
- **Session** — a signed-in browser: hashed token, owner, the household it is
  currently acting in, sliding expiry (§9).
- **Invitation** — an offer of membership: hashed token, the one address that
  may accept, the inviter, whether it joins a household or creates one, an
  expiry, and the timestamps that make it single-use and revocable (§9).
- **AuthToken** — a single-use emailed password-reset link, stored hashed, with
  an expiry and a spent-at marker (§9).
- **NewsletterSend** — one digest, one member, one week; the unique constraint is
  what makes the weekly send idempotent (§9b).
- **AuditEvent** — one thing a platform admin did: the action, the actor, the
  household and person it touched, and a sentence saying what happened. Names
  are snapshotted, not just referenced, so the record outlives what it names
  (§9c).
- **BackupRun** — one attempt at a nightly backup: the day it covers, whether it
  worked, the archive name and sizes, and the diagnosis if it didn't (§11).
- **Settings** — household size, one row per household.

---

## Deferred (not in v1)

- Bulk or automated crawling of source sites — no crawler, no background jobs,
  no re-fetching on a schedule. Single-page import of a URL *you* paste is
  supported (§1); it's a best-effort fetch of one page you chose, with pasted
  recipe text as the fallback when a site blocks it. The app's two timers are the
  exceptions, and narrow ones: the weekly digest (§9b) fetches nothing and calls
  nobody, it only asks the database whether this week's mail is owed, and the
  nightly backup (§11) talks only to a storage box the household chose and paid
  for. Neither reaches out to a service on anyone else's behalf.
- Line-item spend and item-level cost attribution. Receipts are OCR'd for their
  total only (§7); nothing reads the individual products off them.
- Budget targets and over-budget alerts.
- Per-user data isolation / multi-tenancy. Accounts exist (§9), but everyone in
  the household still shares one plan, one library and one ledger.
- Third-party sign-in (Google, Apple). It would make an external service a hard
  dependency for reaching your own kitchen app, against §12. Magic-link sign-in
  over our own SMTP, or passkeys, are the
  self-contained ways to drop the password; `AuthToken.purpose` already carries a
  `MAGIC_LINK` case so neither needs a migration.
- Store-aisle grouping of the shopping list.
- All-meals planning (breakfast/lunch).
