/**
 * Starting the app's two schedulers (§9b, §11).
 *
 * Next runs `register()` once per server process at startup — the one hook the
 * app has for doing something that isn't a request. §9b originally said no
 * scheduler here and left the timing to cron on the host, but that put the
 * decisive part of the send in a crontab: unversioned, absent from a rebuilt
 * box, and silent when wrong. The schedule is code now, and arrives with the
 * deploy that needs it.
 *
 * The nightly backup (§11) moved in here for the same reason and a sharper
 * one. A digest that stops arriving is noticed by five people on Friday; a
 * backup that stops running is noticed once, on the day the disk dies.
 *
 * What this does is deliberately thin. Whether the mail is due is
 * digestSchedule.ts's question, whether a backup is owed is
 * backupSchedule.ts's, and whether either is outstanding belongs to
 * weeklyDigest.ts and backups.ts; this only decides how often to ask.
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
  // nodemailer, no child processes and no timers worth keeping.
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  await startDigestScheduler();
  await startBackupScheduler();
}

async function startDigestScheduler(): Promise<void> {
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

/**
 * Take the backup the schedule owes, when it owes one (§11).
 *
 * The same shape as the digest's timer above, and for the same reasons: ticking
 * often rather than firing at an instant, so a box that was off at three backs
 * up when it comes back, and asking a question that is cheap and idempotent, so
 * a tick that overlaps a restart costs nothing.
 */
async function startBackupScheduler(): Promise<void> {
  const { readBorgConfig, describeRepo } = await import("@/lib/borgConfig");
  const { describeBackupSchedule, runDueBackup } = await import("@/lib/backups");

  const { config, missing, problems } = readBorgConfig();
  for (const problem of problems) console.error(`[backup] ${problem}`);

  if (!config.schedulerEnabled) {
    console.info("[backup] scheduler disabled by BACKUP_SCHEDULER=off");
    return;
  }

  if (missing.length > 0) {
    // Not an error — an instance can be run without backups, and the settings
    // screen says so in plainer words than a log line would. But it must not
    // look like a scheduler that's working.
    console.info(`[backup] not configured (${missing.join(", ")} unset); nothing is being backed up`);
    return;
  }

  // A development machine pointed at a copy of the production database would
  // otherwise write archives of that copy into the household's real
  // repository. Opt in explicitly there, as the digest does.
  const setting = process.env.BACKUP_SCHEDULER?.trim().toLowerCase();
  if (process.env.NODE_ENV !== "production" && setting !== "on") {
    console.info("[backup] scheduler idle in development; set BACKUP_SCHEDULER=on to run it");
    return;
  }

  const where = describeRepo(config.repo);
  console.info(
    `[backup] nightly backup scheduled for ${describeBackupSchedule(config.schedule)} → ${where.host ?? where.display}`,
  );

  let running = false;

  const tick = async () => {
    // A first backup can take minutes; the next tick must not start a second
    // one underneath it. backups.ts guards this too, for the manual button.
    if (running) return;
    running = true;
    try {
      const outcome = await runDueBackup();
      // Null means the owed day is already backed up — the usual answer, and
      // not worth a line every quarter of an hour.
      if (!outcome) return;

      if (outcome.ok) {
        console.info(`[backup] ${outcome.summary}`);
      } else {
        console.error(`[backup] ${outcome.summary ?? "backup failed"}`);
        if (outcome.hint) console.error(`[backup]   ${outcome.hint}`);
      }
    } catch (err) {
      // Never let a bad tick take the server down with an unhandled rejection.
      console.error("[backup] scheduled backup failed", err);
    } finally {
      running = false;
    }
  };

  setTimeout(tick, FIRST_TICK_MS).unref();
  setInterval(tick, TICK_MS).unref();
}
