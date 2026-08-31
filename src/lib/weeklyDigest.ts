/**
 * Gathering and delivering the weekly digest (§9b).
 *
 * The composition itself lives in src/lib/newsletter.ts and is pure; this is
 * the part that talks to Postgres and the SMTP server.
 */

import { prisma } from "@/lib/prisma";
import { unsubscribeToken } from "@/lib/auth";
import { appUrl, sendMail } from "@/lib/mail";
import { type DigestSchedule, dueWeekStart } from "@/lib/digestSchedule";
import {
  type DigestCooked,
  type DigestLookBack,
  type DigestNight,
  type DigestRecipe,
  type DigestSpend,
  type NewsletterInput,
  isWorthSending,
  mondayOf,
  nextMonday,
  renderNewsletter,
} from "@/lib/newsletter";

/** How far back "new in the library" reaches. One digest, one week. */
const NEW_RECIPE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * How many weeks the "your usual week" figure averages over.
 *
 * Four: long enough that one big Sunday shop doesn't set the baseline, short
 * enough that it still tracks a household whose habits changed in the spring.
 */
const AVERAGE_WEEKS = 4;

/**
 * How many of those four weeks must actually contain a shop before the average
 * is quoted.
 *
 * A ledger three weeks old, divided by four, produces a number that is low by
 * construction and would tell a household it overspent every week until the
 * month was out. Two weeks of evidence is the least that makes "your 4-week
 * average" a sentence about them rather than about when they installed this.
 */
const MIN_WEEKS_FOR_AVERAGE = 2;

/** `n` weeks after `weekStart` — negative goes back. Both ends are UTC midnights. */
function addWeeks(weekStart: Date, n: number): Date {
  return new Date(weekStart.getTime() + n * WEEK_MS);
}

/**
 * Who the digest is for: members who asked for it and can act on it.
 *
 * An invited member who hasn't set a password yet has no account to log into,
 * so a mail full of plan links would be a dead end. Declared once because two
 * queries ask the question — who to send to, and whether everyone already has
 * their copy — and an answer that differed between them would either skip a
 * member for the week or re-poll a finished week forever.
 */
const ELIGIBLE = { newsletterOptIn: true, passwordHash: { not: null } } as const;

export interface DigestContent {
  weekStart: Date;
  nights: DigestNight[];
  newRecipes: DigestRecipe[];
  /** What the week now ending held and cost (§7, §8, §9b). */
  lookBack: DigestLookBack;
}

/**
 * Read one household's week once, for everyone in that household.
 *
 * Within a household the contents are identical for every recipient — only
 * the greeting and unsubscribe link differ. Worth doing once per household
 * rather than once per member.
 */
export async function gatherDigest(
  householdId: string,
  weekStart: Date,
  now = new Date(),
): Promise<DigestContent> {
  // The week the mail reports on: the one the reader is living through, which
  // ends the day before the week it looks ahead to.
  const lastWeekStart = addWeeks(weekStart, -1);

  const [plan, recipes, lastPlan, trips] = await Promise.all([
    prisma.weekPlan.findUnique({
      where: { householdId_weekStart: { householdId, weekStart } },
      include: {
        slots: {
          orderBy: [{ dayOfWeek: "asc" }, { position: "asc" }],
          include: { recipe: { select: { id: true, name: true } } },
        },
        // The nights the household has already settled (§3). Without these the
        // digest can't tell a decision from a gap, and nags about both.
        nightNotes: { select: { dayOfWeek: true, kind: true, text: true } },
      },
    }),
    prisma.recipe.findMany({
      where: {
        householdId,
        createdAt: { gte: new Date(now.getTime() - NEW_RECIPE_WINDOW_MS) },
      },
      orderBy: { createdAt: "desc" },
      select: { id: true, name: true },
    }),
    // What was actually cooked. The same query as the week ahead, minus the
    // night notes: "we ate out on Thursday" is a decision worth nudging about
    // before the week, and nobody's news after it.
    prisma.weekPlan.findUnique({
      where: { householdId_weekStart: { householdId, weekStart: lastWeekStart } },
      include: {
        slots: {
          orderBy: [{ dayOfWeek: "asc" }, { position: "asc" }],
          select: {
            dayOfWeek: true,
            recipe: { select: { id: true, name: true } },
          },
        },
      },
    }),
    // Five weeks of the ledger in one query — the week being reported plus the
    // four it is compared against — and bucketed below. Five short rows a week
    // is less traffic than the round trip a second query would cost.
    prisma.shoppingTrip.findMany({
      where: {
        householdId,
        date: { gte: addWeeks(lastWeekStart, -AVERAGE_WEEKS), lt: weekStart },
      },
      select: { date: true, total: true },
    }),
  ]);

  // Always seven nights, whether or not the week exists yet — an empty night
  // is information ("nothing planned"), not something to omit.
  const nights: DigestNight[] = Array.from({ length: 7 }, (_, dayOfWeek) => {
    // At most one, enforced by the (weekPlanId, dayOfWeek) unique index.
    const note = (plan?.nightNotes ?? []).find((n) => n.dayOfWeek === dayOfWeek);
    return {
      dayOfWeek,
      dinners: (plan?.slots ?? [])
        .filter((s) => s.dayOfWeek === dayOfWeek && s.recipe)
        .map((s) => ({ name: s.recipe!.name, servings: s.servingsOverride })),
      // Narrowed to what the wording needs, so the mail can't come to depend on
      // a database row's shape.
      note: note ? { kind: note.kind, text: note.text } : null,
    };
  });

  return {
    weekStart,
    nights,
    newRecipes: recipes,
    lookBack: {
      weekStart: lastWeekStart,
      cooked: foldCooked(lastPlan?.slots ?? []),
      nightsCooked: new Set((lastPlan?.slots ?? []).map((s) => s.dayOfWeek)).size,
      spend: foldSpend(trips, lastWeekStart),
    },
  };
}

/**
 * The week's dinners as a list of dishes, in the order the week ran.
 *
 * Deduplicated by recipe, with a count: a batch of chilli that fed Tuesday and
 * Thursday is one thing the household cooked, and listing it twice reads as a
 * bug in the mail rather than as a fact about the week. First appearance wins
 * the position, so the list still tells the week in order.
 */
function foldCooked(
  slots: { dayOfWeek: number; recipe: { id: string; name: string } }[],
): DigestCooked[] {
  const byRecipe = new Map<string, DigestCooked>();
  for (const slot of slots) {
    const seen = byRecipe.get(slot.recipe.id);
    if (seen) seen.times += 1;
    else byRecipe.set(slot.recipe.id, { ...slot.recipe, times: 1 });
  }
  return [...byRecipe.values()];
}

/**
 * Five weeks of trips split into "the week we're reporting on" and "the four
 * before it", with the latter averaged (§8).
 *
 * The average divides by `AVERAGE_WEEKS`, not by the number of weeks that
 * happened to contain a shop: a fortnightly shopper's *weekly* spend is the
 * four-week total over four, and dividing by two would double it. What the
 * `MIN_WEEKS_FOR_AVERAGE` guard rules out is the other case — a ledger that is
 * simply too young to have a baseline — where dividing by four is arithmetic
 * about the install date rather than about the household.
 */
function foldSpend(
  trips: { date: Date; total: unknown }[],
  lastWeekStart: Date,
): DigestSpend {
  let total = 0;
  let count = 0;
  let priorTotal = 0;
  // Which of the four prior weeks saw a shop, by their Monday's timestamp.
  const priorWeeks = new Set<number>();

  for (const trip of trips) {
    // Prisma hands `@db.Money` back as a Decimal; the digest wants a plain
    // number of kroner and says why in newsletter.ts.
    const amount = Number(trip.total);
    if (!Number.isFinite(amount)) continue;

    if (trip.date >= lastWeekStart) {
      total += amount;
      count += 1;
    } else {
      priorTotal += amount;
      // Keyed by the Monday of the trip's own week rather than by an offset
      // arithmetic'd out of the gap, which lands a Sunday and the Monday six
      // days before it in the same bucket.
      priorWeeks.add(mondayOf(trip.date).getTime());
    }
  }

  return {
    total,
    trips: count,
    average:
      priorWeeks.size >= MIN_WEEKS_FOR_AVERAGE ? priorTotal / AVERAGE_WEEKS : null,
  };
}

/** Build one member's copy: shared content, personal greeting and opt-out. */
export async function composeFor(
  user: { id: string; name: string | null },
  content: DigestContent,
): Promise<ReturnType<typeof renderNewsletter> & { input: NewsletterInput }> {
  const weekKey = content.weekStart.toISOString().slice(0, 10);
  const token = await unsubscribeToken(user.id);

  const input: NewsletterInput = {
    name: user.name,
    weekStart: content.weekStart,
    nights: content.nights,
    newRecipes: content.newRecipes,
    lookBack: content.lookBack,
    links: {
      plan: appUrl(`/plan?weekStart=${weekKey}`),
      shopping: appUrl("/shopping"),
      spending: appUrl("/spending"),
      unsubscribe: appUrl(`/api/newsletter/unsubscribe?u=${user.id}&t=${token}`),
      recipe: (id: string) => appUrl(`/recipes/${id}`),
    },
  };

  return { ...renderNewsletter(input), input };
}

export interface SendReport {
  weekStart: string;
  sent: string[];
  skipped: { email: string; reason: string }[];
  /**
   * The last delivery failure, kept so the "send me one now" button can say
   * what went wrong instead of only that something did.
   */
  lastError?: unknown;
}

/**
 * Send this week's digest to everyone who wants it (§9b).
 *
 * Idempotent: the unique index on (userId, weekStart) means a scheduler tick
 * that repeats, or a retried request, can't deliver twice. `force` bypasses that for
 * the "send me one now" preview button, which deliberately re-sends.
 */
export async function sendWeeklyDigest(opts: {
  /** Defaults to the coming Monday — the week the digest looks ahead to. */
  weekStart?: Date;
  /** Restrict to one member; used by the preview button. */
  onlyUserId?: string;
  /** Restrict to one household; required for an in-app preview. */
  householdId?: string;
  /** Send even if already recorded for this week, and even if there's nothing on. */
  force?: boolean;
  now?: Date;
} = {}): Promise<SendReport> {
  const now = opts.now ?? new Date();
  const weekStart = opts.weekStart ?? nextMonday(now);
  const weekKey = weekStart.toISOString().slice(0, 10);

  const report: SendReport = { weekStart: weekKey, sent: [], skipped: [] };

  const households = await prisma.household.findMany({
    where: {
      ...(opts.householdId ? { id: opts.householdId } : {}),
      memberships: {
        some: {
          ...(opts.onlyUserId ? { userId: opts.onlyUserId } : {}),
          ...(opts.force ? {} : { user: ELIGIBLE }),
        },
      },
    },
    select: { id: true },
  });

  for (const household of households) {
    const users = await prisma.user.findMany({
      where: {
        ...(opts.onlyUserId ? { id: opts.onlyUserId } : {}),
        ...(opts.force ? {} : ELIGIBLE),
        memberships: { some: { householdId: household.id } },
      },
      select: { id: true, email: true, name: true, newsletterOptIn: true },
    });
    const content = await gatherDigest(household.id, weekStart, now);

    if (
      !opts.force &&
      !isWorthSending({
        name: null,
        weekStart,
        nights: content.nights,
        newRecipes: content.newRecipes,
        lookBack: content.lookBack,
        // Links play no part in the decision; blank ones keep the shape honest
        // without inventing URLs nobody will follow.
        links: { plan: "", shopping: "", spending: "", unsubscribe: "", recipe: () => "" },
      })
    ) {
      report.skipped.push({ email: "*", reason: "nothing-to-say" });
      continue;
    }

    for (const user of users) {
      if (!opts.force) {
        // Claim the slot *before* sending. If this throws on the unique index a
        // concurrent run already has it, and the alternative — send first,
        // record after — risks sending twice.
        try {
          await prisma.newsletterSend.create({
            data: { householdId: household.id, userId: user.id, weekStart },
          });
        } catch {
          report.skipped.push({ email: user.email, reason: "already-sent" });
          continue;
        }
      }

      const mail = await composeFor(user, content);

      try {
        await sendMail({
          to: user.email,
          subject: mail.subject,
          text: mail.text,
          html: mail.html,
          headers: {
            "List-Unsubscribe": `<${mail.input.links.unsubscribe}>`,
            "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
          },
        });
        report.sent.push(user.email);
      } catch (err) {
        console.error(`weekly digest to ${user.email} failed`, err);
        report.skipped.push({ email: user.email, reason: "send-failed" });
        report.lastError = err;
        if (!opts.force) {
          await prisma.newsletterSend
            .deleteMany({
              where: { householdId: household.id, userId: user.id, weekStart },
            })
            .catch(() => {});
        }
      }
    }
  }

  return report;
}

/**
 * Whether every eligible member already has this week's copy.
 *
 * The scheduler ticks all weekend, but the week's mail only goes out once.
 * Without this, each tick would re-read the plan and the library to rediscover
 * that there's nothing left to do. Two cheap id queries instead.
 */
async function allDelivered(weekStart: Date): Promise<boolean> {
  const [memberships, sends] = await Promise.all([
    prisma.householdMembership.findMany({
      where: { user: ELIGIBLE },
      select: { householdId: true, userId: true },
    }),
    prisma.newsletterSend.findMany({
      where: { weekStart },
      select: { householdId: true, userId: true },
    }),
  ]);

  // Nobody to send to is "nothing outstanding", not "send forever".
  if (memberships.length === 0) return true;

  const key = (householdId: string | null, userId: string) => `${householdId}:${userId}`;
  const delivered = new Set(sends.map((s) => key(s.householdId, s.userId)));
  return memberships.every((m) => delivered.has(key(m.householdId, m.userId)));
}

/**
 * Send this week's digest if it's due and hasn't gone out yet (§9b).
 *
 * The scheduler's whole body of work. Called on a timer rather than by cron,
 * and safe to call as often as you like: `dueWeekStart` says whether the send
 * hour has passed, `allDelivered` says whether there's anything left to do, and
 * the unique index on (userId, weekStart) is the backstop if two processes ask
 * at once.
 *
 * Because due-ness stays true for the rest of the week rather than firing once,
 * two things fix themselves that host cron could only lose: a box that was off
 * at the send hour sends when it comes back, and a member whose delivery failed
 * — their claim released by sendWeeklyDigest — is retried on the next tick
 * instead of waiting for a week that has already moved on.
 *
 * Returns null when there was nothing to do, so a caller can stay quiet.
 */
export async function sendDueDigest(
  opts: { now?: Date; schedule?: DigestSchedule } = {},
): Promise<SendReport | null> {
  const now = opts.now ?? new Date();

  const weekStart = dueWeekStart(now, opts.schedule);
  if (!weekStart) return null;
  if (await allDelivered(weekStart)) return null;

  return sendWeeklyDigest({ weekStart, now });
}
