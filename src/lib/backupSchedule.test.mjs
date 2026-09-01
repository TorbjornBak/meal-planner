// Tests for the nightly backup's schedule (§11). Run with `npm test`.
//
// The point of the module being pure is that "is last night's backup owed?"
// can be asked of any instant, in any zone, without waiting for 03:00 or
// touching the machine's clock. TZ is never set here: every assertion passes
// the zone explicitly, so the suite answers the same on a laptop in Copenhagen
// and in a UTC container.

import test from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_BACKUP_SCHEDULE,
  backupDueAt,
  describeBackupSchedule,
  dueBackupDay,
  nextBackupAt,
  parseBackupSchedule,
} from "./backupSchedule.ts";

const CPH = DEFAULT_BACKUP_SCHEDULE; // 03:00 Europe/Copenhagen
const UTC = { hour: 3, timeZone: "UTC" };

test("the due instant is a wall clock, not a fixed offset from UTC", () => {
  // Summer (CEST, UTC+2) and winter (CET, UTC+1) put 03:00 local at different
  // instants. A household's backup happens at three either way.
  assert.equal(backupDueAt("2026-08-30", CPH).toISOString(), "2026-08-30T01:00:00.000Z");
  assert.equal(backupDueAt("2026-01-15", CPH).toISOString(), "2026-01-15T02:00:00.000Z");
});

test("03:00 still means 03:00 on the two nights the clocks move", () => {
  // Forward: 29 March 2026, 02:00 CET jumps to 03:00 CEST.
  assert.equal(backupDueAt("2026-03-29", CPH).toISOString(), "2026-03-29T01:00:00.000Z");
  // Back: 25 October 2026, 03:00 CEST falls back to 02:00 CET, so the hour
  // runs twice and 03:00 is the second, CET one.
  assert.equal(backupDueAt("2026-10-25", CPH).toISOString(), "2026-10-25T02:00:00.000Z");
});

test("before the hour, yesterday's backup is the one owed", () => {
  // 02:30 in Copenhagen — the day's run hasn't come round yet.
  assert.equal(dueBackupDay(new Date("2026-08-30T00:30:00Z"), CPH), "2026-08-29");
});

test("from the hour onwards, today's backup is owed", () => {
  assert.equal(dueBackupDay(new Date("2026-08-30T01:00:00Z"), CPH), "2026-08-30");
});

test("the owed day doesn't change as the day wears on, so one day means one backup", () => {
  // Every tick from 03:00 to midnight names the same day. Compared against the
  // last successful run, that's what stops a fifteen-minute timer taking
  // ninety backups.
  for (const iso of [
    "2026-08-30T01:00:00Z",
    "2026-08-30T09:00:00Z",
    "2026-08-30T20:00:00Z",
    "2026-08-30T21:59:00Z",
  ]) {
    assert.equal(dueBackupDay(new Date(iso), CPH), "2026-08-30", `at ${iso}`);
  }
});

test("a box that was off at three still owes that day when it comes back", () => {
  // The whole reason the schedule stopped being a crontab line: a missed cron
  // firing is lost, an owed day is not. Booting at 22:00 owes the same day the
  // 03:00 firing would have covered.
  assert.equal(dueBackupDay(new Date("2026-08-30T20:00:00Z"), CPH), "2026-08-30");
});

test("an instance that has never run owes the day just gone, not a wait until three", () => {
  // dueBackupDay is never "nothing owed": there is always a last elapsed day,
  // so a freshly configured repository is filled at once instead of leaving
  // the household unbacked-up until the small hours.
  const justConfigured = new Date("2026-08-30T00:30:00Z"); // 02:30 local
  assert.equal(dueBackupDay(justConfigured, CPH), "2026-08-29");
});

test("month and year boundaries step back a calendar day", () => {
  // 02:30 on 1 September owes 31 August, not the 0th.
  assert.equal(dueBackupDay(new Date("2026-09-01T00:30:00Z"), CPH), "2026-08-31");
  // 02:30 on 1 January owes 31 December of the year before.
  assert.equal(dueBackupDay(new Date("2026-01-01T01:30:00Z"), CPH), "2025-12-31");
});

test("the day owed is read in the schedule's zone, not the server's", () => {
  // One instant, two zones: 03:00 in Copenhagen is 01:00 UTC, which is still
  // the small hours of the day before as far as a UTC schedule is concerned.
  const instant = new Date("2026-08-30T01:00:00Z");
  assert.equal(dueBackupDay(instant, CPH), "2026-08-30");
  assert.equal(dueBackupDay(instant, UTC), "2026-08-29");
});

test("the next backup is tonight's until it happens, then tomorrow's", () => {
  assert.equal(
    nextBackupAt(new Date("2026-08-30T00:30:00Z"), CPH).toISOString(),
    "2026-08-30T01:00:00.000Z",
  );
  assert.equal(
    nextBackupAt(new Date("2026-08-30T01:00:00Z"), CPH).toISOString(),
    "2026-08-31T01:00:00.000Z",
  );
});

test("an hour outside 0-23 falls back to the default and says so", () => {
  for (const bad of ["25", "-1", "3.5", "three"]) {
    const { schedule, problems } = parseBackupSchedule({ hour: bad });
    assert.equal(schedule.hour, DEFAULT_BACKUP_SCHEDULE.hour, `hour=${bad}`);
    assert.equal(problems.length, 1);
    assert.match(problems[0], /BACKUP_HOUR/);
  }
});

test("an unknown zone falls back to the default and says so", () => {
  const { schedule, problems } = parseBackupSchedule({ timeZone: "Mars/Olympus_Mons" });
  assert.equal(schedule.timeZone, DEFAULT_BACKUP_SCHEDULE.timeZone);
  assert.match(problems[0], /BACKUP_TIMEZONE/);
});

test("unset values are not a problem, they're the default", () => {
  const { schedule, problems } = parseBackupSchedule({ hour: undefined, timeZone: "  " });
  assert.deepEqual(schedule, DEFAULT_BACKUP_SCHEDULE);
  assert.deepEqual(problems, []);
});

test("good values are taken", () => {
  const { schedule, problems } = parseBackupSchedule({ hour: "0", timeZone: "America/New_York" });
  assert.deepEqual(schedule, { hour: 0, timeZone: "America/New_York" });
  assert.deepEqual(problems, []);
});

test("the schedule describes itself for the boot log", () => {
  assert.equal(describeBackupSchedule({ hour: 3, timeZone: "Europe/Copenhagen" }), "03:00 Europe/Copenhagen");
  assert.equal(describeBackupSchedule({ hour: 22, timeZone: "UTC" }), "22:00 UTC");
});
