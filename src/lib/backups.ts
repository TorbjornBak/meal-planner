/**
 * Taking backups, and knowing whether one is owed (§11).
 *
 * The part that talks to Postgres, in the same split weeklyDigest.ts has with
 * newsletter.ts: when a backup is due is backupSchedule.ts's pure question,
 * what the commands are is borgConfig.ts's, what a failure means is
 * borgError.ts's, and running them is borg.ts's. What's left here is the
 * bookkeeping — which is what turns a command that can be run into a backup
 * that is known to have happened.
 */

import type { BackupRun, BackupTrigger } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import {
  BorgCommandError,
  borgVersion,
  listArchives,
  pgDumpVersion,
  readPublicKey,
  repoInfo,
  runBackup,
} from "@/lib/borg";
import {
  type BorgConfig,
  describeRepo,
  readBorgConfig,
  restoreCommands,
} from "@/lib/borgConfig";
import { describeBorgFailure, redact } from "@/lib/borgError";
import { describeBackupSchedule, dueBackupDay, nextBackupAt } from "@/lib/backupSchedule";

export { describeBackupSchedule } from "@/lib/backupSchedule";

/**
 * How long to leave a failed day alone before trying it again.
 *
 * The scheduler ticks every quarter of an hour, and a repository that is
 * refusing the passphrase will refuse it just as firmly at 03:15. An hour is
 * short enough to ride out a storage box that was briefly unreachable, and
 * long enough that a genuinely broken setup writes a handful of rows a day
 * rather than ninety.
 */
const RETRY_AFTER_MS = 60 * 60 * 1000;

/** A "YYYY-MM-DD" day as the UTC midnight Postgres stores for a DATE column. */
function dayToDate(day: string): Date {
  return new Date(`${day}T00:00:00.000Z`);
}

/** The UTC midnight Postgres gave back, as "YYYY-MM-DD". */
function dateToDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export interface BackupOutcome {
  ok: boolean;
  /** The run that was written, if one was attempted. */
  run: BackupRun | null;
  /** Why nothing was attempted — only set when `run` is null. */
  skipped?: "not-configured" | "already-done" | "waiting-to-retry";
  summary?: string;
  hint?: string;
  detail?: string;
}

/**
 * One backup at a time, per process.
 *
 * A scheduled tick and someone pressing Back up now can land together. Rather
 * than starting a second pg_dump and meeting borg's repository lock halfway
 * through, the second caller waits on the first and gets its result — which
 * reads, correctly, as "the backup you asked for happened".
 */
let inFlight: Promise<BackupOutcome> | null = null;

/**
 * Take a backup now, recording the attempt whether or not it works.
 *
 * The row is written *before* the backup starts. A run that never comes back —
 * a box rebooted mid-upload — leaves a row with no `finishedAt`, which is the
 * only way that case is distinguishable afterwards from a backup that was
 * never attempted at all.
 */
export async function takeBackup(options: {
  trigger: BackupTrigger;
  now?: Date;
  config?: BorgConfig;
}): Promise<BackupOutcome> {
  if (inFlight) return inFlight;

  const now = options.now ?? new Date();
  const { config, missing } = options.config
    ? { config: options.config, missing: [] as string[] }
    : readBorgConfig();

  if (missing.length > 0) {
    return {
      ok: false,
      run: null,
      skipped: "not-configured",
      summary: `Backups aren't set up: ${missing.join(" and ")} ${missing.length === 1 ? "is" : "are"} unset.`,
      hint: "Set them in the .env the app container reads, then restart it.",
    };
  }

  const attempt = (async (): Promise<BackupOutcome> => {
    const day = dueBackupDay(now, config.schedule);
    const run = await prisma.backupRun.create({
      data: { day: dayToDate(day), trigger: options.trigger },
    });

    try {
      const result = await runBackup(config, process.env.DATABASE_URL ?? "", now);
      const finished = await prisma.backupRun.update({
        where: { id: run.id },
        data: {
          ok: true,
          finishedAt: new Date(),
          archive: result.archive,
          originalBytes: result.originalBytes === null ? null : BigInt(Math.round(result.originalBytes)),
          compressedBytes:
            result.compressedBytes === null ? null : BigInt(Math.round(result.compressedBytes)),
          dedupedBytes: result.dedupedBytes === null ? null : BigInt(Math.round(result.dedupedBytes)),
          warnings: result.warnings || null,
        },
      });

      return { ok: true, run: finished, summary: `Backed up to ${result.archive}.` };
    } catch (err) {
      const diagnosis =
        err instanceof BorgCommandError
          ? describeBorgFailure(err.failure, { repo: config.repo })
          : {
              summary: "The backup failed before it reached borg.",
              hint: undefined,
              detail: redact(err instanceof Error ? err.message : String(err), [config.passphrase]),
            };

      const finished = await prisma.backupRun.update({
        where: { id: run.id },
        data: {
          ok: false,
          finishedAt: new Date(),
          error: [diagnosis.summary, diagnosis.hint, diagnosis.detail].filter(Boolean).join("\n\n"),
        },
      });

      return { ok: false, run: finished, ...diagnosis };
    }
  })();

  inFlight = attempt;
  try {
    return await attempt;
  } finally {
    inFlight = null;
  }
}

/**
 * Take the backup the schedule owes, if it's still owed.
 *
 * Called on a timer. Returns null when there was nothing to do, so a quiet
 * tick logs nothing — the same shape sendDueDigest uses (§9b).
 */
export async function runDueBackup(now: Date = new Date()): Promise<BackupOutcome | null> {
  const { config, missing } = readBorgConfig();
  if (missing.length > 0 || !config.schedulerEnabled) return null;

  const day = dueBackupDay(now, config.schedule);

  // The newest attempt at the owed day decides what happens: a success means
  // there's nothing to do until tomorrow, and a recent failure means waiting
  // rather than hammering a repository that just said no.
  const latest = await prisma.backupRun.findFirst({
    where: { day: dayToDate(day) },
    orderBy: { startedAt: "desc" },
  });

  if (latest?.ok) return null;
  if (latest && now.getTime() - latest.startedAt.getTime() < RETRY_AFTER_MS) return null;

  return takeBackup({ trigger: "SCHEDULED", now, config });
}

/** A BackupRun as JSON — BigInt columns don't survive JSON.stringify. */
export function serializeRun(run: BackupRun) {
  return {
    id: run.id,
    day: dateToDay(run.day),
    trigger: run.trigger,
    startedAt: run.startedAt.toISOString(),
    finishedAt: run.finishedAt?.toISOString() ?? null,
    ok: run.ok,
    archive: run.archive,
    originalBytes: run.originalBytes === null ? null : Number(run.originalBytes),
    compressedBytes: run.compressedBytes === null ? null : Number(run.compressedBytes),
    dedupedBytes: run.dedupedBytes === null ? null : Number(run.dedupedBytes),
    error: run.error,
    warnings: run.warnings,
  };
}

export type SerializedRun = ReturnType<typeof serializeRun>;

/**
 * Everything the settings screen needs, without touching the network.
 *
 * Reaching the storage box is left to the Check setup button. This is read on
 * every visit to the settings page, and a page that hangs for thirty seconds
 * because a backup host is down would be a worse way to learn that than the
 * red line this returns instead.
 */
export async function backupStatus(now: Date = new Date()) {
  const { config, missing, problems } = readBorgConfig();

  const [runs, lastSuccess, key, borg, pgDump] = await Promise.all([
    prisma.backupRun.findMany({ orderBy: { startedAt: "desc" }, take: 10 }),
    prisma.backupRun.findFirst({ where: { ok: true }, orderBy: { startedAt: "desc" } }),
    readPublicKey(config).catch(() => null),
    borgVersion(),
    pgDumpVersion(),
  ]);

  const dueDay = dueBackupDay(now, config.schedule);

  return {
    configured: missing.length === 0,
    missing,
    problems,
    schedulerEnabled: config.schedulerEnabled,
    schedule: {
      description: describeBackupSchedule(config.schedule),
      hour: config.schedule.hour,
      timeZone: config.schedule.timeZone,
      nextAt: nextBackupAt(now, config.schedule).toISOString(),
    },
    retention: config.retention,
    repo: describeRepo(config.repo),
    key: key ? { path: key.path, publicKey: key.publicKey, fingerprint: key.fingerprint } : null,
    tools: { borg, pgDump },
    /** The day the schedule says should be covered by now. */
    dueDay,
    /** Whether it is. This is the "are we backed up?" answer. */
    upToDate: lastSuccess ? dateToDay(lastSuccess.day) === dueDay : false,
    lastSuccess: lastSuccess ? serializeRun(lastSuccess) : null,
    runs: runs.map(serializeRun),
    restore: restoreCommands(lastSuccess?.archive ?? undefined),
  };
}

/**
 * Reach the repository and report what's there.
 *
 * The one call that proves the whole path — key, network, host, passphrase,
 * repository — works, which is why it's a button rather than something the
 * page does on its own.
 */
export async function checkRepository(): Promise<{
  ok: boolean;
  summary: string;
  hint?: string;
  detail?: string;
  archives?: Array<{ name: string; time: string | null }>;
  uniqueSize?: number | null;
  totalSize?: number | null;
}> {
  const { config, missing } = readBorgConfig();
  if (missing.length > 0) {
    return {
      ok: false,
      summary: `Backups aren't set up: ${missing.join(" and ")} ${missing.length === 1 ? "is" : "are"} unset.`,
      hint: "Set them in the .env the app container reads, then restart it.",
      detail: `missing: ${missing.join(", ")}`,
    };
  }

  try {
    const [info, archives] = await Promise.all([repoInfo(config), listArchives(config, 20)]);
    const where = describeRepo(config.repo);
    return {
      ok: true,
      summary:
        archives.length === 0
          ? `Reached the repository at ${where.host ?? where.path}. It's empty — nothing has been backed up yet.`
          : `Reached the repository at ${where.host ?? where.path}: ${archives.length} ${
              archives.length === 1 ? "archive" : "archives"
            }, ${formatBytes(info.uniqueSize)} stored.`,
      archives,
      uniqueSize: info.uniqueSize,
      totalSize: info.totalSize,
    };
  } catch (err) {
    if (err instanceof BorgCommandError) {
      return { ok: false, ...describeBorgFailure(err.failure, { repo: config.repo }) };
    }
    return {
      ok: false,
      summary: "Couldn't reach the repository.",
      detail: redact(err instanceof Error ? err.message : String(err), [config.passphrase]),
    };
  }
}

/** "1.2 MB" — sizes here are for reading, not for arithmetic. */
export function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined) return "an unknown amount";
  const units = ["B", "kB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000;
    unit += 1;
  }
  return `${value < 10 && unit > 0 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}
