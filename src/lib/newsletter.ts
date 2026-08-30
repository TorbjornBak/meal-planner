/**
 * The weekly digest (§9b).
 *
 * One email a week: the dinners on the coming week's plan, the recipes added to
 * the library since the last one, and — looking the other way — what the week
 * now ending actually cost and what got cooked in it.
 *
 * The forward half is a nudge to fill in the empty nights before the shop. The
 * backward half is the report the app could always have written and never did:
 * the ledger (§7, §8) and the plan both know what happened, but only if you go
 * and look, and nobody opens a spending page on a Friday. Arriving unasked, in
 * the mail that was already going out, is the one way that number gets seen.
 *
 * `renderNewsletter` is deliberately pure — it takes plain data and URLs and
 * returns strings, touching neither the database nor the environment — so the
 * awkward parts (empty nights, a week with nothing on it, plural agreement)
 * are unit-testable without a Postgres or an SMTP server anywhere in sight.
 */

// Imported relatively, with its extension, so `npm test` can run this module
// straight through Node — the `@/` alias only exists inside the bundler.
import { PALETTE, esc, layout, type Composed } from "./emailLayout.ts";
import { nightNoteLabel, type NightNote } from "./nightNotes.ts";

export interface DigestDinner {
  name: string;
  /** Only set when the night overrides the household size (§4). */
  servings?: number | null;
}

export interface DigestNight {
  /** 0 = Monday … 6 = Sunday, matching DinnerSlot.dayOfWeek. */
  dayOfWeek: number;
  dinners: DigestDinner[];
  /**
   * The household's decision that this night needs no dinner (§3) — leftovers,
   * eating out. Absent means nobody has got to it yet, which is the only kind
   * of night this mail should be nudging about.
   */
  note?: NightNote | null;
}

export interface DigestRecipe {
  id: string;
  name: string;
}

/** One dish that actually got cooked in the week being reported on. */
export interface DigestCooked extends DigestRecipe {
  /**
   * How many nights of that week it was on. Almost always 1; a batch of chilli
   * that fed Tuesday and Thursday says "(twice)" rather than appearing in the
   * list twice, which would read like a mistake.
   */
  times: number;
}

/**
 * What the week's shopping came to (§7, §8).
 *
 * Money is a plain number of kroner here, not a Decimal: this module is pure
 * and runs under `node --test` with no Prisma anywhere, and the arithmetic —
 * one subtraction against an average — is nowhere near the precision where
 * binary floating point starts lying about receipt totals.
 */
export interface DigestSpend {
  /** Total across the week's trips. */
  total: number;
  /** How many shops it took. */
  trips: number;
  /**
   * Mean weekly spend over the four weeks before this one, or null when
   * there isn't enough ledger behind it to be worth comparing against.
   * Deciding *that* is the gatherer's job (see weeklyDigest.ts); here it is
   * simply "a number to compare with, or nothing".
   */
  average: number | null;
}

/**
 * The week now ending — the half of the digest that reports rather than nudges.
 *
 * Not the last *complete* week. The digest goes out on a Friday evening (§9b),
 * so the week it names here is the one the reader has just lived through and
 * can still remember paying for; waiting for Sunday midnight to make it
 * complete would buy tidiness at the cost of talking about a week that has
 * already faded. The two nights not yet spent are stated as "so far" in the
 * copy rather than quietly rolled in.
 */
export interface DigestLookBack {
  /** The Monday of the week being reported on — the one before `weekStart`. */
  weekStart: Date;
  /** What was cooked, in the order the week ran. */
  cooked: DigestCooked[];
  /** How many of its nights had a dinner on them. */
  nightsCooked: number;
  spend: DigestSpend;
}

export interface NewsletterInput {
  name: string | null;
  /** The Monday the digest looks ahead to (UTC, date-only). */
  weekStart: Date;
  /** Exactly seven entries, Monday first. */
  nights: DigestNight[];
  newRecipes: DigestRecipe[];
  /**
   * The week just gone. Optional so a caller that only wants the nudge — the
   * "send me one now" preview, a test — can leave it out entirely, and so the
   * composer has exactly one shape to handle for "no ledger, no plan, nothing
   * to report".
   */
  lookBack?: DigestLookBack | null;
  links: {
    plan: string;
    shopping: string;
    unsubscribe: string;
    recipe: (id: string) => string;
    /** The spend ledger (§8), linked from the money line. */
    spending: string;
  };
}

const DAY_NAMES = [
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
  "Sunday",
];

/** Monday (UTC, date-only) of the week containing `d`. Matches /api/plan. */
export function mondayOf(d: Date): Date {
  const day = d.getUTCDay(); // 0 = Sun
  const diff = (day + 6) % 7; // days since Monday
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - diff));
}

/** The Monday of next week — what a digest sent on Friday looks ahead to. */
export function nextMonday(from: Date): Date {
  const monday = mondayOf(from);
  return new Date(monday.getTime() + 7 * 24 * 60 * 60 * 1000);
}

/**
 * Month abbreviations, written out rather than taken from Intl.
 *
 * `Intl.DateTimeFormat` disagrees with itself across ICU versions — the same
 * call renders September as "Sep" on one Node build and "Sept" on another —
 * which would make the digest's wording depend on which image it happened to
 * be sent from. A fixed table renders identically everywhere.
 */
const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

/** "24 Aug" — UTC-pinned so the same week renders the same everywhere. */
function shortDate(d: Date): string {
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
}

function dateOfNight(weekStart: Date, dayOfWeek: number): Date {
  return new Date(weekStart.getTime() + dayOfWeek * 24 * 60 * 60 * 1000);
}

/** "24–30 Aug" or "29 Sep – 5 Oct", depending on whether the month turns over. */
export function weekRangeLabel(weekStart: Date): string {
  const end = dateOfNight(weekStart, 6);
  const sameMonth = weekStart.getUTCMonth() === end.getUTCMonth();
  if (sameMonth) {
    return `${weekStart.getUTCDate()}–${shortDate(end)}`;
  }
  return `${shortDate(weekStart)} – ${shortDate(end)}`;
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/**
 * Kroner, exactly as the spending page writes them (§8).
 *
 * Two decimals and a bare "kr", not `Intl.NumberFormat`: the same reason the
 * month names above are a hand-written table — a digest's numbers must not
 * depend on which ICU build the container happens to ship. Matching the ledger
 * digit for digit matters more than looking tidy, because the first thing
 * anyone does with a number in this mail is click through and check it.
 */
function money(kroner: number): string {
  return `${kroner.toFixed(2)} kr`;
}

/**
 * How the week's spend compares with the weeks before it, or "" when there is
 * nothing honest to compare against.
 *
 * The threshold is a whole krone. Below that the two numbers are the same
 * number as far as anybody cares, and "0.40 kr above your 4-week average" is
 * the kind of precision that makes a reader stop trusting the rest of the mail.
 */
function spendComparison(spend: DigestSpend): string {
  if (spend.average == null) return "";
  const diff = spend.total - spend.average;
  if (Math.abs(diff) < 1) return "about your usual week";
  const direction = diff > 0 ? "above" : "below";
  return `${money(Math.abs(diff))} ${direction} your 4-week average`;
}

/** "twice" / "3 times" — how a repeat is said next to the dish's name. */
function timesLabel(times: number): string {
  if (times <= 1) return "";
  return times === 2 ? " (twice)" : ` (${times} times)`;
}

/**
 * Whether the money line has anything to say.
 *
 * A week with no trips logged still reports — "nothing logged" is exactly the
 * nudge a household that forgot to photograph the receipt needs. But a
 * household that has never used the ledger at all shouldn't be told about the
 * ledger every Friday for ever, so silence needs both: no trips this week, and
 * no average behind it either.
 */
function hasSpendToReport(spend: DigestSpend): boolean {
  return spend.trips > 0 || spend.average != null;
}

/** Whether the week just gone is worth a paragraph. */
function hasLookBack(lookBack: DigestLookBack | null | undefined): lookBack is DigestLookBack {
  return Boolean(lookBack && (lookBack.cooked.length > 0 || hasSpendToReport(lookBack.spend)));
}

/**
 * The money sentence, identical in both renderings, or null when there is
 * nothing to say. Written once because the plain-text part is not a lesser
 * copy of the HTML — some of this household reads the mail in a terminal — and
 * two sentences that drift apart are two sentences to keep correct.
 */
function spendSentence(spend: DigestSpend): string | null {
  if (!hasSpendToReport(spend)) return null;
  if (spend.trips === 0) {
    return "No shopping logged this week — if you shopped, the receipt is still worth a photo.";
  }
  const comparison = spendComparison(spend);
  return `Spent ${money(spend.total)} over ${plural(spend.trips, "shop", "shops")}${
    comparison ? ` — ${comparison}` : ""
  }.`;
}

/**
 * The lead-in to the list of dishes, without the dishes themselves: plain text
 * lists them inline, HTML links each one, and only this half is common.
 * Null when the week held no dinners at all.
 */
function cookedIntro(lookBack: DigestLookBack): string | null {
  if (lookBack.cooked.length === 0) return null;
  return `Cooked on ${plural(lookBack.nightsCooked, "night", "nights")}:`;
}

/**
 * Whether this digest is worth anyone's inbox.
 *
 * A week with nothing planned, nothing new in the library *and* nothing behind
 * it has nothing to say, and a weekly email that regularly says nothing is one
 * people learn to ignore — so the send is skipped rather than delivered empty.
 *
 * The look-back counts. It is the case the original rule got wrong: a household
 * that cooked five dinners and spent 1,200 kr, and simply hasn't planned next
 * week yet, is the household with the most to read and the most to do — and
 * under the old rule it was the one guaranteed to hear nothing.
 */
export function isWorthSending(input: NewsletterInput): boolean {
  return (
    input.newRecipes.length > 0 ||
    // A decided night is a planned night. A household that settles a whole week
    // as leftovers and eating out has planned it, and silence would read as the
    // mail having broken rather than as there being nothing to say.
    input.nights.some((n) => n.dinners.length > 0 || n.note) ||
    hasLookBack(input.lookBack)
  );
}

/**
 * A night nobody has got to yet — the only thing this mail asks anyone to fix.
 *
 * §3 always let a night be empty on purpose, but until notes existed the plan
 * couldn't tell that from a gap, so the digest counted both and told a
 * household whose Wednesday is leftovers by standing arrangement to fill it in,
 * every week, forever. A nudge that is wrong every week is exactly the mail
 * §9b set out not to send.
 */
function isUndecided(night: DigestNight): boolean {
  return night.dinners.length === 0 && !night.note;
}

function dinnerLabel(d: DigestDinner): string {
  return d.servings ? `${d.name} (for ${d.servings})` : d.name;
}

/** Compose the digest into a subject line, plain text, and HTML. */
export function renderNewsletter(input: NewsletterInput): Composed {
  const range = weekRangeLabel(input.weekStart);
  const planned = input.nights.reduce((n, night) => n + night.dinners.length, 0);
  const emptyNights = input.nights.filter(isUndecided).length;
  const hello = input.name ? `Hi ${input.name},` : "Hi,";

  const subject = `Dinners for ${range}${
    input.newRecipes.length ? ` — and ${plural(input.newRecipes.length, "new recipe", "new recipes")}` : ""
  }`;

  // The line mail clients preview next to the subject: lead with whatever's
  // most actionable, which is usually the gap in the plan.
  const preheader = emptyNights
    ? `${plural(emptyNights, "night", "nights")} still to fill.`
    : `${plural(planned, "dinner", "dinners")} planned.`;

  // ---- plain text ----------------------------------------------------------

  const textNights = input.nights
    .map((night) => {
      const date = shortDate(dateOfNight(input.weekStart, night.dayOfWeek));
      const label = `${DAY_NAMES[night.dayOfWeek]} ${date}`;
      // A decision reads as itself; only a genuine gap gets the dash.
      if (night.dinners.length === 0) {
        return `  ${label}: ${night.note ? nightNoteLabel(night.note) : "—"}`;
      }
      return `  ${label}: ${night.dinners.map(dinnerLabel).join(", ")}`;
    })
    .join("\n");

  const textRecipes = input.newRecipes.length
    ? `\n\nNew in the library\n${input.newRecipes.map((r) => `  • ${r.name}`).join("\n")}`
    : "";

  // The week behind, in both renderings. Resolved once so "is there anything
  // to report" is asked in exactly one place.
  const lookBack = hasLookBack(input.lookBack) ? input.lookBack : null;
  const cookedLead = lookBack ? cookedIntro(lookBack) : null;
  const spendLine = lookBack ? spendSentence(lookBack.spend) : null;

  const textLookBack = lookBack
    ? `\n\nThe week just gone, ${weekRangeLabel(lookBack.weekStart)}\n${[
        cookedLead
          ? `  ${cookedLead} ${lookBack.cooked
              .map((c) => `${c.name}${timesLabel(c.times)}`)
              .join(", ")}.`
          : "  Nothing was cooked off the plan.",
        spendLine ? `  ${spendLine}` : null,
      ]
        .filter(Boolean)
        .join("\n")}`
    : "";

  const text = `${hello}

Here's what's for dinner, ${range}.

${textNights}${textRecipes}${textLookBack}

${emptyNights ? `${plural(emptyNights, "night", "nights")} still to fill: ` : "Plan: "}${input.links.plan}
Shopping list: ${input.links.shopping}${lookBack ? `\nSpending: ${input.links.spending}` : ""}

—
Don't want these? Unsubscribe: ${input.links.unsubscribe}`;

  // ---- html ----------------------------------------------------------------

  const htmlNights = input.nights
    .map((night) => {
      const date = shortDate(dateOfNight(input.weekStart, night.dayOfWeek));
      const empty = night.dinners.length === 0;
      const body = empty
        ? // "Nothing planned" is only true of a night nobody has decided. Saying
          // it of a settled one tells the household its own plan doesn't count.
          `<span style="color:${PALETTE.muted};">${
            night.note ? esc(nightNoteLabel(night.note)) : "Nothing planned"
          }</span>`
        : night.dinners
            .map(
              (d) =>
                `<div>${esc(d.name)}${
                  d.servings
                    ? ` <span style="color:${PALETTE.muted};font-size:14px;">for ${d.servings}</span>`
                    : ""
                }</div>`,
            )
            .join("");

      return `<tr>
  <td style="padding:10px 0;border-bottom:1px solid ${PALETTE.border};width:110px;vertical-align:top;">
    <div style="font-weight:600;">${DAY_NAMES[night.dayOfWeek]}</div>
    <div style="color:${PALETTE.muted};font-size:13px;">${esc(date)}</div>
  </td>
  <td style="padding:10px 0;border-bottom:1px solid ${PALETTE.border};vertical-align:top;">${body}</td>
</tr>`;
    })
    .join("\n");

  const htmlRecipes = input.newRecipes.length
    ? `<h2 style="font-size:16px;margin:28px 0 8px 0;">New in the library</h2>
<ul style="margin:0;padding-left:20px;">
${input.newRecipes
  .map(
    (r) =>
      `  <li style="margin:4px 0;"><a href="${esc(input.links.recipe(r.id))}" style="color:${PALETTE.accent};">${esc(r.name)}</a></li>`,
  )
  .join("\n")}
</ul>`
    : "";

  /**
   * The week just gone, as its own block below the plan.
   *
   * Below, and behind a rule, because the mail's job is still the coming week
   * — the empty nights are what somebody has to act on tonight. What last week
   * cost is worth knowing and worth nobody's first thirty seconds.
   */
  const htmlLookBack = lookBack
    ? `<div style="margin:28px 0 0 0;padding:16px 0 0 0;border-top:1px solid ${PALETTE.border};">
<h2 style="font-size:16px;margin:0 0 8px 0;">The week just gone <span style="color:${PALETTE.muted};font-weight:400;">${esc(
        weekRangeLabel(lookBack.weekStart),
      )}</span></h2>
${
  cookedLead
    ? `<p style="margin:0 0 8px 0;">${esc(cookedLead)} ${lookBack.cooked
        .map(
          (c) =>
            `<a href="${esc(input.links.recipe(c.id))}" style="color:${PALETTE.accent};">${esc(
              c.name,
            )}</a>${esc(timesLabel(c.times))}`,
        )
        .join(", ")}.</p>`
    : `<p style="margin:0 0 8px 0;color:${PALETTE.muted};">Nothing was cooked off the plan.</p>`
}
${
  spendLine
    ? `<p style="margin:0;">${esc(spendLine)} <a href="${esc(
        input.links.spending,
      )}" style="color:${PALETTE.accent};">Ledger</a></p>`
    : ""
}
</div>`
    : "";

  const html = layout({
    title: subject,
    preheader,
    body: `<p style="margin:0 0 16px 0;">${esc(hello)} here's what&#39;s for dinner, ${esc(range)}.</p>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="font-size:15px;">
${htmlNights}
</table>
${htmlRecipes}
<p style="margin:24px 0 0 0;">
  <a href="${esc(input.links.plan)}" style="color:${PALETTE.accent};font-weight:600;">${
    emptyNights ? `Fill in the ${plural(emptyNights, "empty night", "empty nights")}` : "Open the plan"
  }</a>
  <span style="color:${PALETTE.muted};"> · </span>
  <a href="${esc(input.links.shopping)}" style="color:${PALETTE.accent};">Shopping list</a>
</p>
${htmlLookBack}`,
    footer: `You get this because you're on the MealPlanner household. <a href="${esc(
      input.links.unsubscribe,
    )}" style="color:${PALETTE.muted};">Unsubscribe</a>.`,
  });

  return { subject, text, html };
}
