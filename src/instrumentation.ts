/**
 * Starting the weekly digest's scheduler (§9b).
 *
 * Next runs `register()` once per server process at startup — the one hook the
 * app has for doing something that isn't a request. §9b originally said no
 * scheduler here and left the timing to cron on the host, but that put the
 * decisive part of the send in a crontab: unversioned, absent from a rebuilt
 * box, and silent when wrong. The schedule is code now, and arrives with the
 * deploy that needs it.
 *
 * What this does is deliberately thin. Whether the mail is due is
 * digestSchedule.ts's question and whether it's outstanding is
 * weeklyDigest.ts's; this only decides how often to ask.
 */

/**
 * Often enough that a box coming back from a reboot sends within the quarter
 * hour, rarely enough that a quiet weekend costs two id queries a tick. The
 * work is idempotent, so the exact number doesn't matter — only that it's well
 * under the window between the send hour and the end of the week.
 */
const TICK_MS = 15 * 60 * 1000;

/** Long enough for Postgres to accept connections after a `compose up`. */
const FIRST_TICK_MS = 30 * 1000;

export async function register(): Promise<void> {
  // register() also runs for the edge runtime, which has no Postgres, no
  // nodemailer and no timers worth keeping.
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  const setting = process.env.DIGEST_SCHEDULER?.trim().toLowerCase();
  if (setting === "off") {
    console.info("[digest] scheduler disabled by DIGEST_SCHEDULER=off");
    return;
  }

  // `next dev` calls register() too, and a dev machine pointed at a copy of the
  // production database would mail the household a real digest from a laptop.
  // Opt in explicitly there.
  if (process.env.NODE_ENV !== "production" && setting !== "on") {
    console.info("[digest] scheduler idle in development; set DIGEST_SCHEDULER=on to run it");
    return;
  }

  const { isMailConfigured } = await import("@/lib/mail");
  const { describeSchedule, parseDigestSchedule } = await import("@/lib/digestSchedule");
  const { sendDueDigest } = await import("@/lib/weeklyDigest");

  const { schedule, problems } = parseDigestSchedule({
    day: process.env.DIGEST_SEND_DAY,
    hour: process.env.DIGEST_SEND_HOUR,
    // TZ is what the rest of the container's local times follow, so honour it
    // before falling back to the default zone.
    timeZone: process.env.DIGEST_TIMEZONE ?? process.env.TZ,
  });
  for (const problem of problems) console.error(`[digest] ${problem}`);

  if (!isMailConfigured()) {
    // Not an error — an instance with no SMTP server is a supported way to run
    // this (§9b) — but it must not look like a scheduler that's working.
    console.info("[digest] no SMTP configured; not scheduling the weekly digest");
    return;
  }

  console.info(`[digest] weekly digest scheduled for ${describeSchedule(schedule)}`);

  let running = false;

  const tick = async () => {
    // A send that outlasts a tick — a slow SMTP server, a long retry — must not
    // have a second one start underneath it.
    if (running) return;
    running = true;
    try {
      const report = await sendDueDigest({ schedule });
      if (!report) return;

      // A week with nothing on it is re-checked every tick until it rolls over,
      // because nothing gets recorded as delivered. Saying so 130 times across a
      // weekend would bury the ticks that did something.
      const quiet =
        report.sent.length === 0 && report.skipped.every((s) => s.reason === "nothing-to-say");
      if (quiet) return;

      console.info(
        `[digest] ${report.weekStart}: sent ${report.sent.length}, skipped ${report.skipped.length}`,
      );
      for (const s of report.skipped) console.info(`[digest]   ${s.email}: ${s.reason}`);
    } catch (err) {
      // Never let a bad tick take the server down with an unhandled rejection;
      // the next one is fifteen minutes away and the work is idempotent.
      console.error("[digest] scheduled send failed", err);
    } finally {
      running = false;
    }
  };

  // unref'd so neither timer keeps the process alive at shutdown.
  setTimeout(tick, FIRST_TICK_MS).unref();
  setInterval(tick, TICK_MS).unref();
}
