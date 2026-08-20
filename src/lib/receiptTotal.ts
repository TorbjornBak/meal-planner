/**
 * Picking the total out of an OCR'd receipt (§7) — deterministic, no LLM.
 *
 * OCR gives us a sloppy transcript of a supermarket receipt: item lines, a
 * total, VAT, what was tendered, what came back as change. Only one of those
 * numbers is the trip's cost, and the wrong one is worse than none at all —
 * "KONTANT 400,00" and "BYTTEPENGE 57,25" sit right next to "AT BETALE 342,75".
 *
 * So we score lines rather than grabbing the biggest number: a line labelled
 * like a total counts for it, a line labelled like VAT, change, cash tendered
 * or a discount counts against it, and only if nothing is labelled at all do we
 * fall back to the largest amount on the receipt.
 *
 * Like the recipe parser (§1) this is best-effort and honest about it: the
 * result is a *suggestion* that the human confirms or overtypes before it
 * reaches the ledger, and we hand back the line we read it from so that check
 * takes a glance rather than a squint at the photo.
 */

export interface ReceiptTotal {
  /** Kroner, e.g. 342.75. */
  amount: number;
  /** The OCR line it was read from, shown so a human can sanity-check it. */
  line: string;
  /**
   * How we found it — `"keyword"` when a total label named the amount,
   * `"largest"` when no label was legible and we took the biggest amount on
   * the receipt. A `"largest"` read deserves more suspicion in the UI.
   */
  basis: "keyword" | "largest";
}

/**
 * An amount with two decimals, in either separator convention: Danish
 * `1.234,50` and `342,75`, or English `1,234.50` and `342.75`.
 *
 * Two decimals are required. Supermarket totals are always printed with øre,
 * and demanding them keeps counts ("TOTAL 3 VARER"), dates and the store's CVR
 * number out of the candidate pool.
 */
const AMOUNT = /(\d{1,3}(?:[.,\u00a0 ]\d{3})+|\d+)[.,](\d{2})(?!\d)/g;

/** Lines whose amount is the total, most explicit first. */
const TOTAL_WORDS: [pattern: RegExp, score: number][] = [
  [/\bat betale\b/, 10],
  [/\bi ?alt\b/, 8],
  [/\btotal\b/, 7],
  [/\bbelob\b/, 5],
  [/\bsum\b/, 5],
  [/\bto pay\b/, 8],
];

/**
 * Lines whose amount is emphatically *not* the total. Scored strongly enough
 * to cancel a total word on the same line, because a line like "TOTAL RABAT"
 * carries both.
 */
const NOT_TOTAL_WORDS: [pattern: RegExp, score: number][] = [
  [/\bmoms\b|\bvat\b/, -20], // VAT, usually printed as "HERAF MOMS 68,55"
  [/\bsubtotal\b|\bdelsum\b/, -12],
  [/\bbyttepenge\b|\btilbage\b|\bretur\b|\bchange\b/, -15], // change given
  [/\bkontant\b|\bmodtaget\b|\bcash\b/, -15], // tendered, not owed
  [/\brabat\b|\bsparet\b|\bbesparelse\b|\bdiscount\b/, -15],
  [/\bbonus\b|\bpoint\b/, -10],
];

/**
 * Fold a line into the shape the keyword patterns expect: lowercase, Danish
 * letters flattened (OCR is unreliable about æøå, and "beløb" has to match
 * whether it came back as "belob" or "belØb"), punctuation to spaces.
 */
function normalize(line: string): string {
  return line
    .toLowerCase()
    .replace(/æ/g, "ae")
    .replace(/ø/g, "o")
    .replace(/å/g, "aa")
    .normalize("NFKD")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/**
 * Read a matched amount token into kroner.
 *
 * The final separator is the decimal point — it's the one with exactly two
 * digits behind it — and every separator before it is a thousands mark,
 * whichever convention the till printed in.
 */
function parseAmount(whole: string, cents: string): number {
  return Number(`${whole.replace(/\D/g, "")}.${cents}`);
}

/** Every amount on a line, ignoring negated ones (returns, discounts). */
function amountsOn(line: string): number[] {
  const out: number[] = [];
  for (const m of line.matchAll(AMOUNT)) {
    // A leading or trailing minus means money coming back, not money owed;
    // Danish tills print both "-25,00" and "25,00-".
    const before = line.slice(0, m.index).trimEnd();
    const after = line.slice(m.index + m[0].length);
    if (before.endsWith("-") || after.startsWith("-")) continue;
    out.push(parseAmount(m[1], m[2]));
  }
  return out;
}

/** How strongly a line claims to hold the total. Negative means it disclaims it. */
function scoreLine(normalized: string): number {
  let score = 0;
  for (const [pattern, points] of [...TOTAL_WORDS, ...NOT_TOTAL_WORDS]) {
    if (pattern.test(normalized)) score += points;
  }
  return score;
}

/**
 * Find the trip's total in an OCR transcript, or null if nothing on it looks
 * like an amount at all.
 */
export function findReceiptTotal(text: string): ReceiptTotal | null {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

  const scored = lines.map((line) => ({
    line,
    score: scoreLine(normalize(line)),
    amounts: amountsOn(line),
  }));

  // The biggest amount on any line that doesn't disclaim being the total. Used
  // both as a tie-break bonus (the total is nearly always the largest number
  // printed) and as the fallback when no label survived OCR.
  const plausible = scored.filter((l) => l.score >= 0).flatMap((l) => l.amounts);
  const largest = plausible.length ? Math.max(...plausible) : null;

  const labelled = scored.flatMap((entry, i) => {
    if (entry.score <= 0) return [];

    // A right-aligned total column sometimes lands on its own line, leaving
    // the label stranded above it. Borrow the next line's amount — but not a
    // line that disclaims being the total.
    const next = scored[i + 1];
    const borrowed = !entry.amounts.length;
    const amounts = borrowed ? (next && next.score >= 0 ? next.amounts : []) : entry.amounts;
    if (!amounts.length) return [];

    const amount = Math.max(...amounts);
    return [
      {
        amount,
        line: borrowed ? `${entry.line} ${next.line}` : entry.line,
        // The total is nearly always the largest number printed, so a label
        // sitting on the largest amount outranks one that isn't.
        rank: entry.score + (amount === largest ? 3 : 0),
      },
    ];
  });

  // Ties go to the lower line: on a two-copy receipt the customer's total is
  // the one printed last.
  const best = labelled.reduce<(typeof labelled)[number] | null>(
    (winner, c) => (winner && winner.rank > c.rank ? winner : c),
    null,
  );
  if (best) return { amount: best.amount, line: best.line, basis: "keyword" };

  if (largest === null) return null;
  const source = scored.find((l) => l.amounts.includes(largest));
  return { amount: largest, line: source?.line ?? "", basis: "largest" };
}
