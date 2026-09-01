/**
 * Starting the app's two schedulers, and refusing to start at all if the
 * secrets they and everything else depend on are missing or wrong (§9b, §11,
 * Phase 6).
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
 * The startup check added for Phase 6 belongs here for a related reason: it's
 * the one place code runs once, before the first request, rather than lazily
 * on whichever request happens to need a given secret first. Whether an
 * environment is fit to run in production is src/lib/startupConfig.ts's
 * question — this only decides what to do with the answer: log it always,
 * and in production, exit before the schedulers below (or anything else) get
 * a chance to run against a secret that's missing, weak or still the example
 * value.
 *
 * What the rest of this does is deliberately thin. Whether the mail is due is
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

/**
 * How often dead sessions and spent links are collected. Daily, because
 * nothing about it is urgent — an expired credential stops working when it
 * expires, not when its row is deleted.
 */
const RETENTION_TICK_MS = 24 * 60 * 60 * 1000;

export async function register(): Promise<void> {
  // register() also runs for the edge runtime, which has no Postgres, no
  // nodemailer, no child processes and no timers worth keeping.
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  await checkStartupSecrets();
  await startDigestScheduler();
  await startBackupScheduler();
  startRetentionSweeper();
}

/**
 * Refuse to start a misconfigured production process (Phase 6).
 *
 * `next build` also runs `register()` while it prerenders pages, and forces
 * NODE_ENV to "production" for the duration — a check keyed on NODE_ENV alone
 * would fail a CI image build over an AUTH_SECRET that only needs to exist in
 * the container that actually serves traffic. NEXT_PHASE is how Next tells
 * the two apart: it's "phase-production-build" only during the build step
 * (see PHASE_PRODUCTION_BUILD in next/dist/shared/lib/constants.js), and unset
 * at runtime under `next start`. Skipping the check there mirrors how the
 * schedulers below already survive a build with no SMTP or backup
 * configuration: by degrading rather than throwing.
 */
async function checkStartupSecrets(): Promise<void> {
  if (process.env.NEXT_PHASE === "phase-production-build") return;

  const { checkStartupConfig } = await import("@/lib/startupConfig");
  const { findings, blocking } = checkStartupConfig(process.env);

  // Every finding is printed, in every environment — including the ones that
  // would be fatal in production — because a `next dev` box left half-set is
  // still worth nagging about, just not worth refusing to serve pages over.
  for (const finding of findings) {
    const blocks = blocking.includes(finding);
    const log = blocks ? console.error : console.warn;
    const label = blocks ? "FATAL" : "warning";
    log(`[startup] ${label}: ${finding.variable}: ${finding.message}`);
  }

  if (blocking.length > 0) {
    // All of them, in one line, up front: a misconfigured deployment should
    // take one restart to fix, not five, each turning up the next problem
    // only after the previous one is patched.
    console.error(
      `[startup] refusing to start: ${blocking.length} problem(s) above must be fixed first (${blocking
        .map((f) => f.variable)
        .join(", ")}).`,
    );
    process.exit(1);
  }
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

/**
 * Delete expired sessions, spent links and stale rate-limit counters (Phase 6).
 *
 * The third timer in this file, and the least interesting one, which is why it
 * is also the shortest: what to delete is src/lib/retention.ts's question, and
 * this only decides how often to ask.
 *
 * Daily rather than every fifteen minutes like the two above, because nothing
 * here is time-critical — an expired session is already unusable the moment it
 * expires, whether or not its row has been collected, so the sweep is
 * housekeeping rather than enforcement. It runs shortly after startup too, so
 * a box that has been off for a month tidies up when it comes back rather than
 * waiting a further day.
 *
 * Unlike the digest and backup schedulers there is no development opt-out. The
 * other two send mail and write to a household's real backup repository, which
 * a laptop pointed at a copy of production must not do; this only deletes rows
 * that are already dead, which is as harmless against a scratch database as
 * against a real one.
 */
function startRetentionSweeper(): void {
  let running = false;

  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const { sweepExpiredCredentials, sweptAnything } = await import("@/lib/retention");
      const report = await sweepExpiredCredentials();
      // A quiet box sweeps nothing most days; saying so daily would be noise.
      if (!sweptAnything(report)) return;
      console.info(
        `[retention] swept ${report.sessions} expired session(s), ` +
          `${report.authTokens} spent or expired link(s), ` +
          `${report.rateLimitCounters} stale rate-limit counter(s)`,
      );
    } catch (err) {
      // Never let a bad tick take the server down with an unhandled rejection;
      // the rows it failed to delete are dead either way, and tomorrow's tick
      // will find them again.
      console.error("[retention] sweep failed", err);
    } finally {
      running = false;
    }
  };

  setTimeout(tick, FIRST_TICK_MS).unref();
  setInterval(tick, RETENTION_TICK_MS).unref();
}
