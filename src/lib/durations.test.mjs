// Tests for the cook-time finder (§2). Run with `npm test`.
//
// The step texts below are the shapes real recipes use — Danish sites the
// library is mostly pasted from, plus English ones.

import test from "node:test";
import assert from "node:assert/strict";

import {
  estimateTotalMinutes,
  findDurations,
  formatClock,
  formatDurationMinutes,
  parseIsoDuration,
} from "./durations.ts";

test("plain minutes, Danish and English", () => {
  assert.deepEqual(
    findDurations("Lad det simre 20 minutter.").map((d) => d.seconds),
    [1200],
  );
  assert.deepEqual(
    findDurations("Simmer for 20 minutes.").map((d) => d.seconds),
    [1200],
  );
  assert.deepEqual(
    findDurations("Bag i 25 min.").map((d) => d.seconds),
    [1500],
  );
});

test("a range times the low end so you look early", () => {
  const [d] = findDurations("Steg dem 8-10 minutter.");
  assert.equal(d.seconds, 480);
  assert.equal(d.text, "8-10 minutter");
  assert.equal(findDurations("Bake for 45 to 50 minutes")[0].seconds, 2700);
});

test("hours, halves and compound times", () => {
  assert.equal(findDurations("Bag i 1 time.")[0].seconds, 3600);
  assert.equal(findDurations("Hviler ½ time.")[0].seconds, 1800);
  assert.equal(findDurations("Koges i 1½ time.")[0].seconds, 5400);
  assert.equal(findDurations("Steg i 1,5 time.")[0].seconds, 5400);
  assert.equal(findDurations("Roast 1 hour and 30 minutes.")[0].seconds, 5400);
  assert.equal(findDurations("I ovnen i 2 timer og 15 minutter")[0].seconds, 8100);
});

test("seconds", () => {
  assert.equal(findDurations("Blancher i 30 sekunder.")[0].seconds, 30);
  assert.equal(findDurations("Blanch for 30 sec")[0].seconds, 30);
});

test("several times in one step, in order, non-overlapping", () => {
  const step = "Steg 5 minutter, vend og steg 3-4 minutter mere.";
  const found = findDurations(step);
  assert.deepEqual(
    found.map((d) => d.seconds),
    [300, 180],
  );
  // The offsets have to line up for the step to be rendered around them.
  assert.equal(step.slice(found[0].start, found[0].end), "5 minutter");
  assert.equal(step.slice(found[1].start, found[1].end), "3-4 minutter");
  assert.ok(found[0].end <= found[1].start);
});

test("numbers that aren't times are left alone", () => {
  // Temperatures, quantities, servings — the whole reason for requiring a unit.
  assert.deepEqual(findDurations("Forvarm ovnen til 200 grader."), []);
  assert.deepEqual(findDurations("Tilsæt 2 dåser hakkede tomater."), []);
  assert.deepEqual(findDurations("Skær kødet i 3 cm tern."), []);
  // A word that merely starts with a unit isn't one.
  assert.deepEqual(findDurations("Efter 20 minutters hvile"), []);
});

test("the countdown reads like a clock", () => {
  assert.equal(formatClock(1200), "20:00");
  assert.equal(formatClock(65), "1:05");
  assert.equal(formatClock(3600), "1:00:00");
  assert.equal(formatClock(5405), "1:30:05");
  assert.equal(formatClock(-3), "0:00");
});

// --- Whole-recipe time --------------------------------------------------------

test("schema.org durations are read as the page wrote them", () => {
  assert.equal(parseIsoDuration("PT1H30M"), 5400);
  assert.equal(parseIsoDuration("PT45M"), 2700);
  assert.equal(parseIsoDuration("PT2H"), 7200);
  assert.equal(parseIsoDuration("PT30S"), 30);
  assert.equal(parseIsoDuration("PT1H30M15S"), 5415);
  // Overnight marinades and slow braises really are written this way.
  assert.equal(parseIsoDuration("P1DT2H"), 93600);
  // Sites that lower-case it, pad it, or put a fraction where ISO wouldn't.
  assert.equal(parseIsoDuration("pt45m"), 2700);
  assert.equal(parseIsoDuration("  PT45M  "), 2700);
  assert.equal(parseIsoDuration("PT0.5H"), 1800);
});

test("anything that isn't a duration is null, never a throw", () => {
  // A stranger's page fills this field; every one of these has been seen.
  assert.equal(parseIsoDuration("45 minutes"), null);
  assert.equal(parseIsoDuration(""), null);
  assert.equal(parseIsoDuration("PT"), null); // matches the shape, says nothing
  assert.equal(parseIsoDuration("P"), null);
  assert.equal(parseIsoDuration("1H30M"), null); // no leading P
  assert.equal(parseIsoDuration("PT1H30"), null); // unit missing
  assert.equal(parseIsoDuration("-PT1H"), null);
  assert.equal(parseIsoDuration("banana"), null);
  // Months have no fixed length, so we decline rather than guess.
  assert.equal(parseIsoDuration("P1M"), null);
  // A declared zero is a template nobody filled in.
  assert.equal(parseIsoDuration("PT0M"), null);
});

test("the fallback estimate sums the step timers, rounded to five minutes", () => {
  // 20 + 25 = 45 exactly.
  assert.equal(
    estimateTotalMinutes("Steg 20 minutter.\nBag den 25 minutter."),
    45,
  );
  // 8 (low end of the range) + 25 = 33 → "about 35", not a precise-looking 33.
  assert.equal(
    estimateTotalMinutes("Steg dem 8-10 minutter.\nLad den simre 25 minutter."),
    35,
  );
  assert.equal(estimateTotalMinutes("Bag i 1 time og 30 minutter."), 90);
  // A method with no timeable phrase gets no number at all.
  assert.equal(estimateTotalMinutes("Bland det hele. Server straks."), null);
  assert.equal(estimateTotalMinutes(null), null);
  // Never rounds a real cook time away to nothing.
  assert.equal(estimateTotalMinutes("Blancher i 30 sekunder."), 5);
});

test("a total time reads the way you'd say it", () => {
  assert.equal(formatDurationMinutes(45), "45 min");
  assert.equal(formatDurationMinutes(60), "1 h");
  assert.equal(formatDurationMinutes(90), "1 h 30 min");
  assert.equal(formatDurationMinutes(150), "2 h 30 min");
});
