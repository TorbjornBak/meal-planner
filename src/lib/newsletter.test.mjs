// Tests for the weekly digest composer (§9b). Run with `npm test`.
//
// Node runs the TypeScript module directly (type stripping), so there's no test
// framework or build step to keep alive. renderNewsletter is pure — no
// database, no SMTP — so the awkward cases can all be exercised here.

import test from "node:test";
import assert from "node:assert/strict";

import {
  isWorthSending,
  mondayOf,
  nextMonday,
  renderNewsletter,
  weekRangeLabel,
} from "./newsletter.ts";

/** Monday 24 August 2026. */
const WEEK = new Date(Date.UTC(2026, 7, 24));

const LINKS = {
  plan: "https://box.ts.net/plan?weekStart=2026-08-24",
  shopping: "https://box.ts.net/shopping",
  spending: "https://box.ts.net/spending",
  unsubscribe: "https://box.ts.net/api/newsletter/unsubscribe?u=abc&t=def",
  recipe: (id) => `https://box.ts.net/recipes/${id}`,
};

/**
 * A look-back at the week before WEEK — Mon 17 Aug 2026 — with nothing in it
 * unless the test says otherwise.
 */
function lookBack(overrides = {}) {
  return {
    weekStart: new Date(Date.UTC(2026, 7, 17)),
    cooked: [],
    nightsCooked: 0,
    spend: { total: 0, trips: 0, average: null },
    ...overrides,
  };
}

/** Seven empty nights, with the given days filled in (and optionally decided). */
function nights(filled = {}, notes = {}) {
  return Array.from({ length: 7 }, (_, dayOfWeek) => ({
    dayOfWeek,
    dinners: filled[dayOfWeek] ?? [],
    note: notes[dayOfWeek] ?? null,
  }));
}

function input(overrides = {}) {
  return {
    name: "Torbjørn",
    weekStart: WEEK,
    nights: nights(),
    newRecipes: [],
    links: LINKS,
    ...overrides,
  };
}

test("mondayOf snaps any day of the week back to its Monday", () => {
  // Monday itself stays put; Sunday goes back six days, not forward one.
  assert.equal(mondayOf(new Date(Date.UTC(2026, 7, 24))).toISOString(), WEEK.toISOString());
  assert.equal(mondayOf(new Date(Date.UTC(2026, 7, 27))).toISOString(), WEEK.toISOString());
  assert.equal(mondayOf(new Date(Date.UTC(2026, 7, 30))).toISOString(), WEEK.toISOString());
});

test("nextMonday looks ahead to the coming week, from any day of this one", () => {
  const expected = new Date(Date.UTC(2026, 7, 31)).toISOString();
  // Friday-evening cron and a Sunday-night re-run must agree on the week.
  assert.equal(nextMonday(new Date(Date.UTC(2026, 7, 28))).toISOString(), expected);
  assert.equal(nextMonday(new Date(Date.UTC(2026, 7, 30))).toISOString(), expected);
});

test("week range collapses the month when it doesn't turn over", () => {
  assert.equal(weekRangeLabel(WEEK), "24–30 Aug");
});

test("week range spells out both months when the week straddles them", () => {
  // Mon 28 Sep – Sun 4 Oct 2026.
  assert.equal(weekRangeLabel(new Date(Date.UTC(2026, 8, 28))), "28 Sep – 4 Oct");
});

test("a week with no dinners and no new recipes isn't worth sending", () => {
  assert.equal(isWorthSending(input()), false);
});

test("a single new recipe is enough to be worth sending", () => {
  assert.equal(isWorthSending(input({ newRecipes: [{ id: "r1", name: "Dal" }] })), true);
});

test("a single planned dinner is enough to be worth sending", () => {
  assert.equal(
    isWorthSending(input({ nights: nights({ 2: [{ name: "Frikadeller" }] }) })),
    true,
  );
});

test("subject names the week, and the new recipes when there are any", () => {
  const bare = renderNewsletter(input({ nights: nights({ 0: [{ name: "Dal" }] }) }));
  assert.equal(bare.subject, "Dinners for 24–30 Aug");

  const withOne = renderNewsletter(
    input({ newRecipes: [{ id: "r1", name: "Dal" }] }),
  );
  assert.equal(withOne.subject, "Dinners for 24–30 Aug — and 1 new recipe");

  const withTwo = renderNewsletter(
    input({
      newRecipes: [
        { id: "r1", name: "Dal" },
        { id: "r2", name: "Grød" },
      ],
    }),
  );
  assert.equal(withTwo.subject, "Dinners for 24–30 Aug — and 2 new recipes");
});

test("every night appears, empty ones included, with its date", () => {
  const { text } = renderNewsletter(
    input({ nights: nights({ 0: [{ name: "Frikadeller" }] }) }),
  );

  assert.match(text, /Monday 24 Aug: Frikadeller/);
  // An unplanned night is stated, not omitted — that's the nudge.
  assert.match(text, /Tuesday 25 Aug: —/);
  assert.match(text, /Sunday 30 Aug: —/);
});

test("several dinners on one night are listed together", () => {
  const { text } = renderNewsletter(
    input({
      nights: nights({ 4: [{ name: "Pizza" }, { name: "Salat" }] }),
    }),
  );
  assert.match(text, /Friday 28 Aug: Pizza, Salat/);
});

test("a per-night servings override is spelled out", () => {
  const { text, html } = renderNewsletter(
    input({ nights: nights({ 5: [{ name: "Lasagne", servings: 6 }] }) }),
  );
  assert.match(text, /Saturday 29 Aug: Lasagne \(for 6\)/);
  assert.match(html, /for 6/);
});

test("recipe names are HTML-escaped but left alone in the text part", () => {
  const { html, text } = renderNewsletter(
    input({ newRecipes: [{ id: "r1", name: "Fish & <chips>" }] }),
  );
  assert.match(html, /Fish &amp; &lt;chips&gt;/);
  assert.ok(!html.includes("<chips>"), "raw angle brackets must not reach the HTML");
  assert.match(text, /Fish & <chips>/);
});

test("both parts carry the unsubscribe link", () => {
  const { html, text } = renderNewsletter(
    input({ nights: nights({ 0: [{ name: "Dal" }] }) }),
  );
  assert.ok(text.includes(LINKS.unsubscribe));
  // In HTML the query separator is escaped, as an attribute value requires —
  // mail clients decode it back to "&" when the link is followed.
  assert.ok(html.includes(LINKS.unsubscribe.replace(/&/g, "&amp;")));
});

test("the plan link points at the week the digest is about", () => {
  const { html, text } = renderNewsletter(
    input({ nights: nights({ 0: [{ name: "Dal" }] }) }),
  );
  assert.ok(text.includes("weekStart=2026-08-24"));
  assert.ok(html.includes("weekStart=2026-08-24"));
});

test("the call to action counts the empty nights, and drops away at a full week", () => {
  const partial = renderNewsletter(
    input({ nights: nights({ 0: [{ name: "Dal" }] }) }),
  );
  assert.match(partial.html, /Fill in the 6 empty nights/);

  const full = renderNewsletter(
    input({
      nights: nights(
        Object.fromEntries(Array.from({ length: 7 }, (_, i) => [i, [{ name: "Dal" }]])),
      ),
    }),
  );
  assert.match(full.html, /Open the plan/);
  assert.ok(!full.html.includes("Fill in the"));
});

test("one empty night is singular", () => {
  const { html } = renderNewsletter(
    input({
      nights: nights(
        Object.fromEntries(Array.from({ length: 6 }, (_, i) => [i, [{ name: "Dal" }]])),
      ),
    }),
  );
  assert.match(html, /Fill in the 1 empty night\b/);
  assert.ok(!html.includes("empty nights"));
});

test("greets by name when there is one, and stays polite when there isn't", () => {
  assert.match(renderNewsletter(input()).text, /^Hi Torbjørn,/);
  assert.match(renderNewsletter(input({ name: null })).text, /^Hi,/);
});

// ---------------------------------------------------------------------------
// Decided nights (§3, §9b)
//
// The bug these exist to hold shut: an empty night and a settled one used to be
// the same thing to this mail, so a household whose Wednesday is leftovers by
// standing arrangement was told to fill it in every week for as long as they
// kept the arrangement. A nudge that is wrong every week is the mail §9b was
// written not to send.
// ---------------------------------------------------------------------------

test("a decided night is not a night to fill in", () => {
  const one = renderNewsletter(
    input({ nights: nights({ 0: [{ name: "Lasagne" }] }) }),
  );
  // Monday cooked, the other six untouched.
  assert.match(one.html, /Fill in the 6 empty nights/);

  const settled = renderNewsletter(
    input({
      nights: nights(
        { 0: [{ name: "Lasagne" }] },
        { 2: { kind: "LEFTOVERS" }, 4: { kind: "OUT" } },
      ),
    }),
  );
  // Wednesday and Friday are decided, so only four nights are actually open.
  assert.match(settled.html, /Fill in the 4 empty nights/);
  assert.doesNotMatch(settled.html, /Fill in the 6 empty nights/);
});

test("a fully decided week asks for nothing", () => {
  const notes = {};
  for (let d = 1; d < 7; d += 1) notes[d] = { kind: "OUT" };
  const composed = renderNewsletter(
    input({ nights: nights({ 0: [{ name: "Lasagne" }] }, notes) }),
  );
  assert.match(composed.html, /Open the plan/);
  assert.doesNotMatch(composed.html, /Fill in/);
  assert.match(composed.text, /^Plan: /m);
  // The preheader should stop counting gaps and report what's planned instead.
  assert.doesNotMatch(composed.html, /still to fill/);
});

test("both halves of the mail say what the night was decided to be", () => {
  const composed = renderNewsletter(
    input({
      nights: nights(
        {},
        {
          2: { kind: "LEFTOVERS", text: "the lasagne from Sunday" },
          4: { kind: "OUT" },
          5: { kind: "OTHER", text: "Fasting" },
        },
      ),
    }),
  );

  // §9b requires plain text alongside the HTML, and the two must agree.
  for (const body of [composed.html, composed.text]) {
    assert.match(body, /Leftovers — the lasagne from Sunday/);
    assert.match(body, /Eating out/);
    assert.match(body, /Fasting/);
  }
  // An undecided night still reads as a gap in the text copy.
  assert.match(composed.text, /Monday 24 Aug: —/);
  assert.match(composed.html, /Nothing planned/);
});

test("a week of nothing but decisions is still worth sending", () => {
  const notes = {};
  for (let d = 0; d < 7; d += 1) notes[d] = { kind: "OUT" };
  // Nothing is cooking, but the household planned that on purpose — silence
  // would read as the mail having broken.
  assert.equal(isWorthSending(input({ nights: nights({}, notes) })), true);
  // A week nobody has touched still says nothing, and still isn't sent.
  assert.equal(isWorthSending(input()), false);
});

// ---------------------------------------------------------------------------
// The week just gone (§7, §8, §9b)
//
// The half of the mail that reports rather than nudges: what got cooked, and
// what the shopping came to. All of it is arithmetic the app already had and
// never said out loud, so the cases worth pinning are the ones where saying it
// would be wrong — a ledger too young to average, a week nobody shopped, a dish
// cooked twice.
// ---------------------------------------------------------------------------

test("the week just gone is headed with its own range, not the coming week's", () => {
  const { text, html } = renderNewsletter(
    input({
      lookBack: lookBack({
        cooked: [{ id: "r1", name: "Lasagne", times: 1 }],
        nightsCooked: 1,
      }),
    }),
  );
  assert.match(text, /The week just gone, 17–23 Aug/);
  assert.match(html, /The week just gone/);
  assert.ok(html.includes("17–23 Aug"));
  // The coming week still leads the mail.
  assert.match(text, /Here's what's for dinner, 24–30 Aug/);
});

test("what was cooked is listed, and links through in the HTML", () => {
  const { text, html } = renderNewsletter(
    input({
      lookBack: lookBack({
        cooked: [
          { id: "r1", name: "Lasagne", times: 1 },
          { id: "r2", name: "Dal", times: 1 },
        ],
        nightsCooked: 2,
      }),
    }),
  );
  assert.match(text, /Cooked on 2 nights: Lasagne, Dal\./);
  assert.ok(html.includes("https://box.ts.net/recipes/r1"));
  assert.ok(html.includes("https://box.ts.net/recipes/r2"));
});

test("a dish cooked twice says so once instead of appearing twice", () => {
  const { text } = renderNewsletter(
    input({
      lookBack: lookBack({
        cooked: [{ id: "r1", name: "Chili", times: 2 }],
        nightsCooked: 2,
      }),
    }),
  );
  assert.match(text, /Cooked on 2 nights: Chili \(twice\)/);
  assert.equal(text.match(/Chili/g).length, 1);
});

test("three nights of the same dish counts rather than saying twice", () => {
  const { text } = renderNewsletter(
    input({
      lookBack: lookBack({
        cooked: [{ id: "r1", name: "Grød", times: 3 }],
        nightsCooked: 3,
      }),
    }),
  );
  assert.match(text, /Grød \(3 times\)/);
});

test("one cooked night is singular", () => {
  const { text } = renderNewsletter(
    input({
      lookBack: lookBack({
        cooked: [{ id: "r1", name: "Dal", times: 1 }],
        nightsCooked: 1,
      }),
    }),
  );
  assert.match(text, /Cooked on 1 night: Dal/);
});

test("the week's spend is stated with the number of shops it took", () => {
  const { text, html } = renderNewsletter(
    input({ lookBack: lookBack({ spend: { total: 1247.5, trips: 2, average: null } }) }),
  );
  assert.match(text, /Spent 1247\.50 kr over 2 shops\./);
  assert.match(html, /Spent 1247\.50 kr over 2 shops\./);
  // And a way to go and check it.
  assert.ok(html.includes(LINKS.spending));
  assert.ok(text.includes(LINKS.spending));
});

test("one shop is singular", () => {
  const { text } = renderNewsletter(
    input({ lookBack: lookBack({ spend: { total: 400, trips: 1, average: null } }) }),
  );
  assert.match(text, /over 1 shop\./);
});

test("spend is compared with the four weeks behind it, in both directions", () => {
  const over = renderNewsletter(
    input({ lookBack: lookBack({ spend: { total: 1200, trips: 2, average: 1000 } }) }),
  );
  assert.match(over.text, /200\.00 kr above your 4-week average/);

  const under = renderNewsletter(
    input({ lookBack: lookBack({ spend: { total: 900, trips: 2, average: 1000 } }) }),
  );
  assert.match(under.text, /100\.00 kr below your 4-week average/);
});

test("a difference of small change reads as an ordinary week", () => {
  const { text } = renderNewsletter(
    input({ lookBack: lookBack({ spend: { total: 1000.4, trips: 2, average: 1000 } }) }),
  );
  assert.match(text, /Spent 1000\.40 kr over 2 shops — about your usual week\./);
  // The point of the threshold: the *difference* isn't quoted back. No
  // "0.40 kr above your 4-week average" precision theatre.
  assert.ok(!text.includes("above"));
  assert.ok(!text.includes("below"));
});

test("no average means no comparison rather than a comparison with zero", () => {
  const { text } = renderNewsletter(
    input({ lookBack: lookBack({ spend: { total: 800, trips: 1, average: null } }) }),
  );
  assert.match(text, /Spent 800\.00 kr over 1 shop\./);
  assert.ok(!text.includes("average"));
});

test("a week with an average but no shops says nothing was logged", () => {
  const { text } = renderNewsletter(
    input({ lookBack: lookBack({ spend: { total: 0, trips: 0, average: 900 } }) }),
  );
  assert.match(text, /No shopping logged this week/);
  assert.ok(!text.includes("0.00 kr"));
});

test("a household that has never used the ledger is never told about it", () => {
  const { text, html } = renderNewsletter(
    input({
      lookBack: lookBack({
        cooked: [{ id: "r1", name: "Dal", times: 1 }],
        nightsCooked: 1,
        spend: { total: 0, trips: 0, average: null },
      }),
    }),
  );
  // The cooking half still reports; the money half stays quiet entirely.
  assert.match(text, /Cooked on 1 night: Dal\./);
  assert.ok(!text.includes("shopping logged"));
  assert.ok(!html.includes("Ledger"));
});

test("a week that was paid for but not cooked says both things", () => {
  const { text } = renderNewsletter(
    input({ lookBack: lookBack({ spend: { total: 500, trips: 1, average: null } }) }),
  );
  assert.match(text, /Nothing was cooked off the plan\./);
  assert.match(text, /Spent 500\.00 kr/);
});

test("an empty week behind adds nothing to the mail at all", () => {
  const { text, html } = renderNewsletter(
    input({ nights: nights({ 0: [{ name: "Dal" }] }), lookBack: lookBack() }),
  );
  assert.ok(!text.includes("The week just gone"));
  assert.ok(!html.includes("The week just gone"));
  // And no spending link appears out of nowhere in the footer block.
  assert.ok(!text.includes(LINKS.spending));
});

test("a cooked dish's name is escaped in the HTML and left alone in the text", () => {
  const { html, text } = renderNewsletter(
    input({
      lookBack: lookBack({
        cooked: [{ id: "r1", name: "Steak & <ale> pie", times: 1 }],
        nightsCooked: 1,
      }),
    }),
  );
  assert.match(html, /Steak &amp; &lt;ale&gt; pie/);
  assert.ok(!html.includes("<ale>"), "raw angle brackets must not reach the HTML");
  assert.match(text, /Steak & <ale> pie/);
});

test("last week's cooking alone is worth sending, even with nothing planned", () => {
  // The case the old rule got wrong: a household that cooked and shopped, and
  // simply hasn't filled in next week yet, has the most to read and the most
  // to do — and used to hear nothing.
  assert.equal(
    isWorthSending(
      input({ lookBack: lookBack({ cooked: [{ id: "r1", name: "Dal", times: 1 }], nightsCooked: 1 }) }),
    ),
    true,
  );
  assert.equal(
    isWorthSending(input({ lookBack: lookBack({ spend: { total: 700, trips: 1, average: null } }) })),
    true,
  );
});

test("an empty week behind doesn't make an empty week ahead worth sending", () => {
  assert.equal(isWorthSending(input({ lookBack: lookBack() })), false);
  assert.equal(isWorthSending(input({ lookBack: null })), false);
});
