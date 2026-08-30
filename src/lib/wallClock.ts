/**
 * Wall-clock time in a named zone.
 *
 * Extracted from src/lib/digestSchedule.ts when the backups (§11) needed the
 * same trick the weekly digest (§9b) needed: "03:00 in Copenhagen" is not a
 * fixed number of hours from UTC, and the two weekends a year when it moves are
 * exactly the ones a hand-rolled offset gets wrong. One home for that, so a
 * fix lands for both schedules at once.
 *
 * Pure by construction: no clock of its own, no `process.env`, no `TZ`. Every
 * function takes the instant and the zone, which is what makes the schedules
 * built on it testable in August without waiting for October.
 */

/**
 * `Intl.DateTimeFormat` is used here where newsletter.ts deliberately avoids
 * it. That module needed month *names*, which differ across ICU builds ("Sep"
 * vs "Sept"); this needs numbers, which don't. The alternative is a hand-rolled
 * table of DST rules, which would be wrong the first time a government moved a
 * changeover date.
 */
const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hour12: false,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    formatters.set(timeZone, f);
  }
  return f;
}

/** True if the runtime recognises this zone — an unknown one throws. */
export function isValidTimeZone(timeZone: string): boolean {
  try {
    formatterFor(timeZone);
    return true;
  } catch {
    return false;
  }
}

export interface WallClock {
  year: number;
  /** 1-12, as a human writes it — not a JavaScript month index. */
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

/** What the clock on the wall in `timeZone` reads at `instant`. */
export function wallClockAt(instant: Date, timeZone: string): WallClock {
  const parts = formatterFor(timeZone).formatToParts(instant);
  const at = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  return {
    year: at("year"),
    month: at("month"),
    day: at("day"),
    // Midnight comes back as hour 24 on some ICU builds and 0 on others.
    hour: at("hour") === 24 ? 0 : at("hour"),
    minute: at("minute"),
    second: at("second"),
  };
}

/** The calendar date in `timeZone` at `instant`, as "YYYY-MM-DD". */
export function localDay(instant: Date, timeZone: string): string {
  const { year, month, day } = wallClockAt(instant, timeZone);
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/** How far the zone's wall clock runs ahead of UTC at a given instant. */
function zoneOffsetMs(instant: Date, timeZone: string): number {
  const { year, month, day, hour, minute, second } = wallClockAt(instant, timeZone);
  const asUtc = Date.UTC(year, month - 1, day, hour, minute, second);
  return asUtc - instant.getTime();
}

/**
 * The instant at which a wall-clock time in a zone occurs.
 *
 * Two passes, because the offset has to be read at the answer rather than at
 * the guess: on the weekend a zone shifts, the offset an hour before the
 * changeover isn't the offset an hour after, and a single pass lands an hour
 * out. The second pass re-reads the offset at the instant the first produced.
 */
export function instantAt(
  year: number,
  monthIndex: number,
  day: number,
  hour: number,
  timeZone: string,
): Date {
  const naive = Date.UTC(year, monthIndex, day, hour);
  const firstPass = naive - zoneOffsetMs(new Date(naive), timeZone);
  return new Date(naive - zoneOffsetMs(new Date(firstPass), timeZone));
}
