/**
 * The weekly digest (§9b).
 *
 * One email a week: the dinners on the coming week's plan, and the recipes
 * added to the library since the last one. It's a nudge to fill in the empty
 * nights before the shop, not a report.
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

export interface NewsletterInput {
  name: string | null;
  /** The Monday the digest looks ahead to (UTC, date-only). */
  weekStart: Date;
  /** Exactly seven entries, Monday first. */
  nights: DigestNight[];
  newRecipes: DigestRecipe[];
  links: { plan: string; shopping: string; unsubscribe: string; recipe: (id: string) => string };
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
 * Whether this digest is worth anyone's inbox.
 *
 * A week with no dinners *and* no new recipes has nothing to say, and a weekly
 * email that regularly says nothing is one people learn to ignore — so the
 * send is skipped rather than delivered empty.
 */
export function isWorthSending(input: NewsletterInput): boolean {
  return (
    input.newRecipes.length > 0 ||
    // A decided night is a planned night. A household that settles a whole week
    // as leftovers and eating out has planned it, and silence would read as the
    // mail having broken rather than as there being nothing to say.
    input.nights.some((n) => n.dinners.length > 0 || n.note)
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

  const text = `${hello}

Here's what's for dinner, ${range}.

${textNights}${textRecipes}

${emptyNights ? `${plural(emptyNights, "night", "nights")} still to fill: ` : "Plan: "}${input.links.plan}
Shopping list: ${input.links.shopping}

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
</p>`,
    footer: `You get this because you're on the MealPlanner household. <a href="${esc(
      input.links.unsubscribe,
    )}" style="color:${PALETTE.muted};">Unsubscribe</a>.`,
  });

  return { subject, text, html };
}
