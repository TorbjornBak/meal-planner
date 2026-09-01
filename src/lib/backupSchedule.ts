/**
 * When a backup is owed (§11).
 *
 * Backups used to be `scripts/backup.sh` in the host's crontab, which is the
 * arrangement §9b already threw out for the weekly digest: unversioned, absent
 * from a rebuilt box, and silent when it's wrong. It is a worse arrangement
 * here than it was there. A digest that stops arriving is noticed by five
 * people on Friday; a backup that stops running is noticed once, on the day
 * the disk dies, and by then the answer is already no.
 *
 * So the schedule is code, and it asks the same question §9b's does: not "is
 * it 03:00?" — a moment a sleeping box misses for good — but "which day's
 * backup should exist by now?" A box that was off at three answers with
 * yesterday's date the moment it comes back, and the run happens then.
 *
 * Pure, like digestSchedule.ts: no database, no `process.env`, no clock. The
 * awkward part — an hour that means a wall clock, not UTC — is decided here and
 * tested without waiting for tomorrow.
 */

import { instantAt, isValidTimeZone, wallClockAt } from "./wallClock.ts";

export interface BackupSchedule {
  /** Hour of the local wall clock, 0–23. */
  hour: number;
  /** IANA zone the hour is read in, e.g. "Europe/Copenhagen". */
  timeZone: string;
}

/**
 * Three in the morning: after any evening's cooking, planning and receipt
 * photos have been saved, and long before anyone opens the shopping list.
 */
export const DEFAULT_BACKUP_SCHEDULE: BackupSchedule = {
  hour: 3,
  timeZone: "Europe/Copenhagen",
};

const DAY_MS = 24 * 60 * 60 * 1000;

/** "YYYY-MM-DD" for a plain calendar date. */
function isoDay(year: number, month: number, day: number): string {
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/** The instant `day`'s backup becomes due, in the schedule's zone. */
export function backupDueAt(day: string, schedule: BackupSchedule): Date {
  const [year, month, dayOfMonth] = day.split("-").map(Number);
  return instantAt(year, month - 1, dayOfMonth, schedule.hour, schedule.timeZone);
}

/**
 * The day whose backup should already exist at `now`, as "YYYY-MM-DD" in the
 * schedule's zone.
 *
 * Before the hour, that's yesterday; after it, today. It is never "nothing":
 * an instance that has never backed up owes one for the last elapsed day, and
 * so takes its first backup as soon as it's configured rather than waiting for
 * the small hours to come round.
 *
 * Compare it against the last run recorded as successful. Equal means the
 * repository is as current as the schedule promises; different means a run is
 * outstanding — whether that's because it's now past three, because the box
 * was off at three, or because last night's attempt failed.
 */
export function dueBackupDay(now: Date, schedule: BackupSchedule = DEFAULT_BACKUP_SCHEDULE): string {
  const clock = wallClockAt(now, schedule.timeZone);
  if (clock.hour >= schedule.hour) return isoDay(clock.year, clock.month, clock.day);

  // Yesterday, as a calendar step rather than a subtraction of real time: the
  // date before the 26th is the 25th even on the night the clocks moved.
  const yesterday = new Date(Date.UTC(clock.year, clock.month - 1, clock.day) - DAY_MS);
  return isoDay(
    yesterday.getUTCFullYear(),
    yesterday.getUTCMonth() + 1,
    yesterday.getUTCDate(),
  );
}

/** When the next backup will be taken, for telling someone what to expect. */
export function nextBackupAt(
  now: Date,
  schedule: BackupSchedule = DEFAULT_BACKUP_SCHEDULE,
): Date {
  const clock = wallClockAt(now, schedule.timeZone);
  const today = backupDueAt(isoDay(clock.year, clock.month, clock.day), schedule);
  if (now.getTime() < today.getTime()) return today;

  const tomorrow = new Date(Date.UTC(clock.year, clock.month - 1, clock.day) + DAY_MS);
  return backupDueAt(
    isoDay(tomorrow.getUTCFullYear(), tomorrow.getUTCMonth() + 1, tomorrow.getUTCDate()),
    schedule,
  );
}

export interface ParsedBackupSchedule {
  schedule: BackupSchedule;
  /** Human-readable complaints about the input; each field falls back to its default. */
  problems: string[];
}

/**
 * Read a schedule from configuration strings.
 *
 * A bad value falls back to the default and says so rather than throwing — a
 * mistyped hour must not stop the app booting, and must not pass in silence
 * either, which is the whole reason the schedule moved in here.
 */
export function parseBackupSchedule(env: {
  hour?: string | undefined;
  timeZone?: string | undefined;
}): ParsedBackupSchedule {
  const problems: string[] = [];
  const schedule: BackupSchedule = { ...DEFAULT_BACKUP_SCHEDULE };

  const rawHour = env.hour?.trim();
  if (rawHour) {
    const hour = Number(rawHour);
    if (!Number.isInteger(hour) || hour < 0 || hour > 23) {
      problems.push(`BACKUP_HOUR="${rawHour}" is not an hour 0-23; using ${schedule.hour}.`);
    } else {
      schedule.hour = hour;
    }
  }

  const rawZone = env.timeZone?.trim();
  if (rawZone) {
    if (!isValidTimeZone(rawZone)) {
      problems.push(`BACKUP_TIMEZONE="${rawZone}" is not a known IANA zone; using ${schedule.timeZone}.`);
    } else {
      schedule.timeZone = rawZone;
    }
  }

  return { schedule, problems };
}

/** "03:00 Europe/Copenhagen" — for the boot log and the settings screen. */
export function describeBackupSchedule(schedule: BackupSchedule): string {
  return `${String(schedule.hour).padStart(2, "0")}:00 ${schedule.timeZone}`;
}
