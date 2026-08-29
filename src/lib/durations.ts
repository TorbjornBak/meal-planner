/**
 * Cook times inside a recipe step (§2) — "lad den simre 20-25 minutter" becomes
 * a timer you start with one tap, so cooking mode doesn't need a second device.
 *
 * Deterministic like the rest of the parsing (§1, §12): a regex over the step
 * text, Danish and English units, no LLM. It is deliberately conservative — a
 * number must be followed by a time word, so oven temperatures ("180 grader")
 * and quantities ("2 dåser") never turn into timers.
 */

export interface Duration {
  /** Where the phrase starts in the step text. */
  start: number;
  /** One past where it ends, so `text.slice(start, end)` is the phrase. */
  end: number;
  /** The phrase as written, e.g. "20-25 minutter". */
  text: string;
  /**
   * How long to run. A range times the *low* end: looking early costs a glance,
   * looking late costs the dinner.
   */
  seconds: number;
}

// A number: "20", "1,5", "1½" or a bare "½".
const NUM = String.raw`\d+\s*[½⅓⅔¼¾]|[½⅓⅔¼¾]|\d+(?:[.,]\d+)?`;
// What sits between the ends of a range: "20-25", "20 til 25", "20 to 25".
const RANGE = String.raw`\s*(?:[-–—]|til|to|or|eller)\s*`;

const HOURS = String.raw`timer|time|hours|hour|hrs|hr`;
const MINUTES = String.raw`minutter|minutes|minute|minut|mins|min`;
const SECONDS = String.raw`sekunder|sekund|seconds|second|secs|sec|sek`;
const UNIT = `${HOURS}|${MINUTES}|${SECONDS}`;
// Nothing wordlike may follow, so "minutters" or "second-guess" don't count.
// The full stop of "20 min." is left outside the phrase — it may just as well
// be the end of the sentence, and swallowing it makes the chip read wrong.
const UNIT_END = String.raw`(?![\p{L}])`;

const DURATION_RE = new RegExp(
  `(${NUM})(?:${RANGE}(${NUM}))?\\s*(${UNIT})${UNIT_END}` +
    // "1 time og 30 minutter" / "1 hr 30 min" — a second, smaller part.
    `(?:\\s*(?:og|and)?\\s*(${NUM})\\s*(${MINUTES}|${SECONDS})${UNIT_END})?`,
  "giu",
);

const FRACTIONS: Record<string, number> = {
  "½": 0.5,
  "⅓": 1 / 3,
  "⅔": 2 / 3,
  "¼": 0.25,
  "¾": 0.75,
};

/** "1½" → 1.5, "1,5" → 1.5. */
function toNumber(token: string): number {
  const t = token.replace(/\s+/g, "");
  const frac = t.match(/[½⅓⅔¼¾]$/);
  if (frac) {
    const whole = t.slice(0, -1);
    return (whole ? Number(whole) : 0) + FRACTIONS[frac[0]];
  }
  return Number(t.replace(",", "."));
}

/** The unit already matched the alternation above, so its first letter is enough. */
function unitSeconds(unit: string): number {
  const u = unit[0].toLowerCase();
  if (u === "t" || u === "h") return 3600;
  if (u === "s") return 1;
  return 60;
}

/**
 * Every timeable phrase in `text`, in the order it appears. Non-overlapping,
 * so a step can be rendered by walking the list and slicing between hits.
 */
export function findDurations(text: string): Duration[] {
  const found: Duration[] = [];
  for (const m of text.matchAll(DURATION_RE)) {
    const [phrase, low, , unit, extraNum, extraUnit] = m;
    let seconds = toNumber(low) * unitSeconds(unit);
    if (extraNum && extraUnit) seconds += toNumber(extraNum) * unitSeconds(extraUnit);
    seconds = Math.round(seconds);
    if (seconds <= 0) continue;
    found.push({
      start: m.index,
      end: m.index + phrase.length,
      text: phrase,
      seconds,
    });
  }
  return found;
}

/** "1:30", "20:00", "1:05:00" — the countdown as you'd read it on a clock. */
export function formatClock(seconds: number): string {
  const s = Math.max(0, Math.ceil(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const mm = h > 0 ? String(m).padStart(2, "0") : String(m);
  return `${h > 0 ? `${h}:` : ""}${mm}:${String(sec).padStart(2, "0")}`;
}

// --- Whole-recipe time (§2) ---------------------------------------------------

// An ISO-8601 duration as schema.org writes it: "PT1H30M", "PT45M", "P1DT2H".
// Deliberately narrow — days, hours, minutes, seconds. ISO's `M` means *months*
// before the `T` and minutes after it, and a month has no fixed length, so a
// page that says "P1M" gets null rather than a guess. The `i` flag is for the
// sites that lower-case it ("pt45m"); the optional decimals are for the ones
// that write "PT0.5H", which ISO only allows on the final component but which
// pages emit anyway.
const ISO_DURATION_RE =
  /^P(?:(\d+(?:[.,]\d+)?)D)?(?:T(?:(\d+(?:[.,]\d+)?)H)?(?:(\d+(?:[.,]\d+)?)M)?(?:(\d+(?:[.,]\d+)?)S)?)?$/i;

/**
 * A schema.org duration in seconds, or null if the string isn't one.
 *
 * This is how a recipe page states its own `totalTime` / `prepTime` /
 * `cookTime`, and it is the honest number: the site's claim about its own
 * recipe rather than something we inferred. Still deterministic and
 * in-process (§1, §12) — it's a regex over a string the page already gave us.
 *
 * Seconds, like everything else in this module, even though every caller wants
 * minutes — one unit through the file is worth one division at the edge.
 *
 * Never throws: the input is whatever a stranger's page put in the field, so
 * anything unparseable (empty, "45 minutes", a bare "P", a zero duration)
 * comes back null and the caller falls through to its next-best source.
 */
export function parseIsoDuration(value: string): number | null {
  const m = value.trim().match(ISO_DURATION_RE);
  if (!m) return null;
  const [, days, hours, minutes, seconds] = m;
  // "P" and "PT" match the pattern but say nothing.
  if (!days && !hours && !minutes && !seconds) return null;

  const n = (token: string | undefined) => (token ? Number(token.replace(",", ".")) : 0);
  const total = n(days) * 86400 + n(hours) * 3600 + n(minutes) * 60 + n(seconds);
  // A declared zero ("PT0M") is a field somebody left in the template.
  return total > 0 ? Math.round(total) : null;
}

/**
 * Roughly how long a recipe takes, read off its own method text by adding up
 * every step timer (§2). The last resort when the source page declared no time
 * — and a genuine guess, not a measurement:
 *
 *   - steps overlap (the sauce simmers while the pasta boils),
 *   - resting and marinating time counts as cooking time here,
 *   - knife work, and anything a step doesn't put a number on, counts as zero.
 *
 * The first two push the sum up, the third pushes it down, and the first two
 * usually win — so this systematically *overstates* a recipe. Callers must
 * mark it as an estimate (Recipe.totalTimeIsEstimate) and present it with an
 * "about", never as a fact.
 *
 * Rounded to five minutes for the same reason: summing 8-10 minutes here and
 * 25 there to arrive at "43 min" would dress a guess up as arithmetic.
 * Returns null when the method carries no timeable phrase at all — no number
 * beats a made-up one.
 */
export function estimateTotalMinutes(
  instructions: string | null | undefined,
): number | null {
  if (!instructions) return null;
  const seconds = findDurations(instructions).reduce((total, d) => total + d.seconds, 0);
  if (seconds <= 0) return null;
  return Math.max(5, Math.round(seconds / 60 / 5) * 5);
}

/** "45 min", "1 h", "1 h 30 min" — a whole-recipe time as you'd say it aloud. */
export function formatDurationMinutes(minutes: number): string {
  const m = Math.max(0, Math.round(minutes));
  const h = Math.floor(m / 60);
  const rest = m % 60;
  if (h === 0) return `${rest} min`;
  if (rest === 0) return `${h} h`;
  return `${h} h ${rest} min`;
}
