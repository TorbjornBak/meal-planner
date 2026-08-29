// Tests for the weekly digest's schedule (§9b). Run with `npm test`.
//
// The point of this module being pure is that "is it Friday evening yet?" can
// be asked of an arbitrary instant, in an arbitrary zone, without waiting for
// Friday or setting the machine's clock. TZ is never touched here: every
// assertion passes the zone explicitly, so the suite gives the same answer on a
// laptop in Copenhagen and in a UTC container.

import test from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_SCHEDULE,
  describeSchedule,
  digestDueAt,
  dueWeekStart,
  parseDigestSchedule,
} from "./digestSchedule.ts";

/** Friday 28 August 2026, 17:00 in Copenhagen (CEST, UTC+2) — the default send. */
const FRIDAY_SEND = new Date("2026-08-28T15:00:00Z");

test("not due before the send hour", () => {
  const justBefore = new Date(FRIDAY_SEND.getTime() - 60_000);
  assert.equal(dueWeekStart(justBefore), null);
});

test("due at the send hour, for the coming Monday", () => {
  const week = dueWeekStart(FRIDAY_SEND);
  assert.equal(week?.toISOString(), "2026-08-31T00:00:00.000Z");
});

test("stays due for the rest of the week, so a box that was off catches up", () => {
  // Saturday lunchtime and Sunday evening both still owe the same week's mail.
  for (const iso of ["2026-08-29T12:00:00Z", "2026-08-30T20:00:00Z"]) {
    assert.equal(
      dueWeekStart(new Date(iso))?.toISOString(),
      "2026-08-31T00:00:00.000Z",
      `expected ${iso} to still owe the 31 Aug digest`,
    );
  }
});

test("a new week is not due until its own Friday", () => {
  // Monday 31 August: the week rolled over, and Friday hasn't come round again.
  assert.equal(dueWeekStart(new Date("2026-08-31T09:00:00Z")), null);
  // The following Friday owes the week after.
  assert.equal(
    dueWeekStart(new Date("2026-09-04T15:00:00Z"))?.toISOString(),
    "2026-09-07T00:00:00.000Z",
  );
});

test("the send hour is a wall clock, not UTC", () => {
  // Summer: Copenhagen is UTC+2, so 17:00 local is 15:00Z.
  assert.equal(digestDueAt(new Date("2026-08-26T00:00:00Z")).toISOString(), "2026-08-28T15:00:00.000Z");
  // Winter: UTC+1, so the same 17:00 local is 16:00Z. A schedule stored as a
  // fixed UTC hour would drift an hour twice a year.
  assert.equal(digestDueAt(new Date("2026-12-02T00:00:00Z")).toISOString(), "2026-12-04T16:00:00.000Z");
});

test("survives the weekend the clocks change", () => {
  // Europe/Copenhagen returns to UTC+1 on Sunday 25 October 2026. A Sunday
  // send hour that weekend is the case a single-pass offset lookup gets wrong.
  const sunday = { dayOfWeek: 6, hour: 17, timeZone: "Europe/Copenhagen" };
  assert.equal(
    digestDueAt(new Date("2026-10-23T00:00:00Z"), sunday).toISOString(),
    "2026-10-25T16:00:00.000Z",
  );
});

test("a zone that doesn't observe DST is left alone", () => {
  const utc = { dayOfWeek: 4, hour: 17, timeZone: "UTC" };
  assert.equal(digestDueAt(FRIDAY_SEND, utc).toISOString(), "2026-08-28T17:00:00.000Z");
});

test("defaults to Friday evening in Copenhagen when nothing is configured", () => {
  const { schedule, problems } = parseDigestSchedule({});
  assert.deepEqual(schedule, DEFAULT_SCHEDULE);
  assert.deepEqual(problems, []);
  assert.equal(describeSchedule(schedule), "Friday 17:00 Europe/Copenhagen");
});

test("reads a configured day, hour and zone", () => {
  const { schedule, problems } = parseDigestSchedule({
    day: "sun",
    hour: "9",
    timeZone: "America/New_York",
  });
  assert.deepEqual(schedule, { dayOfWeek: 6, hour: 9, timeZone: "America/New_York" });
  assert.deepEqual(problems, []);
});

test("full weekday names and stray case are accepted", () => {
  assert.equal(parseDigestSchedule({ day: "Thursday" }).schedule.dayOfWeek, 3);
  assert.equal(parseDigestSchedule({ day: " mon " }).schedule.dayOfWeek, 0);
});

test("a bad value falls back to the default and says so", () => {
  const day = parseDigestSchedule({ day: "Caturday" });
  assert.equal(day.schedule.dayOfWeek, DEFAULT_SCHEDULE.dayOfWeek);
  assert.match(day.problems[0], /DIGEST_SEND_DAY/);

  const hour = parseDigestSchedule({ hour: "25" });
  assert.equal(hour.schedule.hour, DEFAULT_SCHEDULE.hour);
  assert.match(hour.problems[0], /DIGEST_SEND_HOUR/);

  // "17:00" is the shape someone reaching for cron syntax would write.
  assert.match(parseDigestSchedule({ hour: "17:00" }).problems[0], /DIGEST_SEND_HOUR/);

  const zone = parseDigestSchedule({ timeZone: "Europe/Copenhaven" });
  assert.equal(zone.schedule.timeZone, DEFAULT_SCHEDULE.timeZone);
  assert.match(zone.problems[0], /DIGEST_TIMEZONE/);
});
