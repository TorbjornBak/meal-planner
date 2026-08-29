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
  type DigestNight,
  type DigestRecipe,
  type NewsletterInput,
  isWorthSending,
  nextMonday,
  renderNewsletter,
} from "@/lib/newsletter";

/** How far back "new in the library" reaches. One digest, one week. */
const NEW_RECIPE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

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
}

/**
 * Read the household's week once, for everyone.
 *
 * There's one plan and one library (§9), so the contents are identical for
 * every recipient — only the greeting and the unsubscribe link differ. Worth
 * doing once rather than per member.
 */
export async function gatherDigest(weekStart: Date, now = new Date()): Promise<DigestContent> {
  const [plan, recipes] = await Promise.all([
    prisma.weekPlan.findUnique({
      where: { weekStart },
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
      where: { createdAt: { gte: new Date(now.getTime() - NEW_RECIPE_WINDOW_MS) } },
      orderBy: { createdAt: "desc" },
      select: { id: true, name: true },
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

  return { weekStart, nights, newRecipes: recipes };
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
    links: {
      plan: appUrl(`/plan?weekStart=${weekKey}`),
      shopping: appUrl("/shopping"),
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
  /** Send even if already recorded for this week, and even if there's nothing on. */
  force?: boolean;
  now?: Date;
} = {}): Promise<SendReport> {
  const now = opts.now ?? new Date();
  const weekStart = opts.weekStart ?? nextMonday(now);
  const weekKey = weekStart.toISOString().slice(0, 10);

  const users = await prisma.user.findMany({
    where: {
      ...(opts.onlyUserId ? { id: opts.onlyUserId } : {}),
      ...(opts.force ? {} : ELIGIBLE),
    },
    select: { id: true, email: true, name: true, newsletterOptIn: true },
  });

  const content = await gatherDigest(weekStart, now);
  const report: SendReport = { weekStart: weekKey, sent: [], skipped: [] };

  if (!opts.force && !isWorthSending({
    name: null,
    weekStart,
    nights: content.nights,
    newRecipes: content.newRecipes,
    links: { plan: "", shopping: "", unsubscribe: "", recipe: () => "" },
  })) {
    report.skipped.push({ email: "*", reason: "nothing-to-say" });
    return report;
  }

  for (const user of users) {
    if (!opts.force) {
      // Claim the slot *before* sending. If this throws on the unique index a
      // concurrent run already has it, and the alternative — send first,
      // record after — risks sending twice.
      try {
        await prisma.newsletterSend.create({ data: { userId: user.id, weekStart } });
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
          // Lets a mail client offer its own unsubscribe button, which is what
          // people actually reach for instead of scrolling to the footer.
          "List-Unsubscribe": `<${mail.input.links.unsubscribe}>`,
          "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
        },
      });
      report.sent.push(user.email);
    } catch (err) {
      console.error(`weekly digest to ${user.email} failed`, err);
      report.skipped.push({ email: user.email, reason: "send-failed" });
      report.lastError = err;
      // Release the claim so the next run retries rather than silently
      // skipping this member for the week.
      if (!opts.force) {
        await prisma.newsletterSend
          .deleteMany({ where: { userId: user.id, weekStart } })
          .catch(() => {});
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
  const [users, sends] = await Promise.all([
    prisma.user.findMany({ where: ELIGIBLE, select: { id: true } }),
    prisma.newsletterSend.findMany({ where: { weekStart }, select: { userId: true } }),
  ]);

  // Nobody to send to is "nothing outstanding", not "send forever".
  if (users.length === 0) return true;

  const delivered = new Set(sends.map((s) => s.userId));
  return users.every((u) => delivered.has(u.id));
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
