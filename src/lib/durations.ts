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
