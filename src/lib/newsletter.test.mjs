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
  unsubscribe: "https://box.ts.net/api/newsletter/unsubscribe?u=abc&t=def",
  recipe: (id) => `https://box.ts.net/recipes/${id}`,
};

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
