/**
 * When the weekly digest is due (§9b).
 *
 * §9b used to say "no scheduler inside the app" and leaned on host cron. That
 * put the one part of the send nothing could test — a crontab line, unversioned
 * and invisible to the repo — in charge of whether the mail went out at all.
 * The schedule lives here instead.
 *
 * Deliberately pure: no database, no `process.env`, no clock of its own. It
 * answers one question — given an instant, is this week's digest due yet? —
 * so the awkward parts (a send hour that means a wall clock, not UTC; the two
 * weekends a year when that hour lands on a DST change) are unit-testable with
 * no Postgres, no SMTP and no waiting until Friday.
 */

import { mondayOf, nextMonday } from "./newsletter.ts";
import { instantAt, isValidTimeZone } from "./wallClock.ts";

/** Monday-first, matching DinnerSlot.dayOfWeek and DigestNight.dayOfWeek. */
const DAY_NAMES = ["MON", "TUE", "WED", "THU", "FRI", "SAT", "SUN"];

export interface DigestSchedule {
  /** 0 = Monday … 6 = Sunday. The day *before* the week being sent about. */
  dayOfWeek: number;
  /** Hour of the local wall clock, 0–23. */
  hour: number;
  /** IANA zone the hour is read in, e.g. "Europe/Copenhagen". */
  timeZone: string;
}

/**
 * Friday evening suits a weekend shop: the digest looks ahead to the coming
 * Monday, so it arrives while there's still time to fill the empty nights in.
 */
export const DEFAULT_SCHEDULE: DigestSchedule = {
  dayOfWeek: 4,
  hour: 17,
  timeZone: "Europe/Copenhagen",
};

/**
 * The instant this week's digest becomes due.
 *
 * Anchored to the Monday of the week containing `now` (UTC, as WeekPlan.weekStart
 * is a date), then walked forward to the send day and the local send hour.
 */
export function digestDueAt(now: Date, schedule: DigestSchedule = DEFAULT_SCHEDULE): Date {
  const monday = mondayOf(now);
  const sendDay = new Date(monday.getTime() + schedule.dayOfWeek * 24 * 60 * 60 * 1000);
  return instantAt(
    sendDay.getUTCFullYear(),
    sendDay.getUTCMonth(),
    sendDay.getUTCDate(),
    schedule.hour,
    schedule.timeZone,
  );
}

/**
 * The week whose digest should have gone out by `now`, or null if it hasn't
 * come round yet.
 *
 * Stays true for the rest of the week once the hour passes, rather than being
 * true only at the moment itself. That's what lets a box that was off at 17:00
 * on Friday send when it comes back on Saturday — the thing host cron could
 * never do, because a missed firing is simply lost.
 */
export function dueWeekStart(now: Date, schedule: DigestSchedule = DEFAULT_SCHEDULE): Date | null {
  return now.getTime() >= digestDueAt(now, schedule).getTime() ? nextMonday(now) : null;
}

export interface ParsedSchedule {
  schedule: DigestSchedule;
  /** Human-readable complaints about the input; each field falls back to its default. */
  problems: string[];
}

/**
 * Read a schedule from configuration strings.
 *
 * A bad value falls back to the default and says so, rather than throwing. An
 * unparseable hour shouldn't stop the app from booting, but it must not pass
 * silently either — the whole point of moving the schedule into the app was to
 * stop misconfiguration being invisible.
 */
export function parseDigestSchedule(env: {
  day?: string | undefined;
  hour?: string | undefined;
  timeZone?: string | undefined;
}): ParsedSchedule {
  const problems: string[] = [];
  const schedule: DigestSchedule = { ...DEFAULT_SCHEDULE };

  const rawDay = env.day?.trim();
  if (rawDay) {
    const index = DAY_NAMES.indexOf(rawDay.toUpperCase().slice(0, 3));
    if (index === -1) {
      problems.push(`DIGEST_SEND_DAY="${rawDay}" is not a weekday; using ${DAY_NAMES[schedule.dayOfWeek]}.`);
    } else {
      schedule.dayOfWeek = index;
    }
  }

  const rawHour = env.hour?.trim();
  if (rawHour) {
    const hour = Number(rawHour);
    if (!Number.isInteger(hour) || hour < 0 || hour > 23) {
      problems.push(`DIGEST_SEND_HOUR="${rawHour}" is not an hour 0-23; using ${schedule.hour}.`);
    } else {
      schedule.hour = hour;
    }
  }

  const rawZone = env.timeZone?.trim();
  if (rawZone) {
    if (!isValidTimeZone(rawZone)) {
      problems.push(`DIGEST_TIMEZONE="${rawZone}" is not a known IANA zone; using ${schedule.timeZone}.`);
    } else {
      schedule.timeZone = rawZone;
    }
  }

  return { schedule, problems };
}

/** "Friday 17:00 Europe/Copenhagen" — for the boot log, so the setting is visible. */
export function describeSchedule(schedule: DigestSchedule): string {
  const day = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"][
    schedule.dayOfWeek
  ];
  return `${day} ${String(schedule.hour).padStart(2, "0")}:00 ${schedule.timeZone}`;
}
