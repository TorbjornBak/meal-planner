/**
 * Running borg and pg_dump (§11).
 *
 * The impure half of the backup: everything that spawns a process, touches the
 * filesystem or talks to the storage box. What each command *is* lives in
 * src/lib/borgConfig.ts and what a failure *means* in src/lib/borgError.ts,
 * both pure and both tested; this module is deliberately the thinnest layer
 * that can turn those into a backup.
 *
 * Nothing here throws a bare Error: every failure comes back as a
 * BorgCommandError carrying the exit code and stderr, which is what the
 * settings screen turns into a sentence.
 */

import { spawn } from "node:child_process";
import { mkdir, readFile, stat } from "node:fs/promises";
import { dirname } from "node:path";

import {
  type BorgConfig,
  archiveName,
  borgEnv,
  compactArgs,
  createArgs,
  deleteArchiveArgs,
  infoArgs,
  initArgs,
  listArgs,
  pruneArgs,
} from "./borgConfig.ts";
import { type BorgFailure, isWarningExit, redact } from "./borgError.ts";
import { pgDumpArgs } from "./pgConnection.ts";

/**
 * How long a single command may take.
 *
 * The first backup uploads the whole database and can be slow on a home line;
 * later ones send only changed chunks and take seconds. An hour is generous
 * for the first and still bounded, so a hung SSH connection can't leave a
 * backup "running" until the next reboot.
 */
const CREATE_TIMEOUT_MS = 60 * 60 * 1000;

/** Everything else is a round trip to the repository, not an upload. */
const QUICK_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * How much of a command's output is kept.
 *
 * Borg can produce a great deal of it, and all of this ends up in a database
 * column and on a settings screen. The tail is the useful end: that's where
 * the error is.
 */
const MAX_OUTPUT_BYTES = 16 * 1024;

export class BorgCommandError extends Error {
  readonly failure: BorgFailure;

  constructor(failure: BorgFailure) {
    super(`${failure.command} failed (${failure.exitCode ?? failure.signal})`);
    this.name = "BorgCommandError";
    this.failure = failure;
  }
}

interface RunResult {
  stdout: string;
  stderr: string;
  /** null when the process was killed rather than exiting — a timeout. */
  exitCode: number | null;
}

interface RunOptions {
  env?: Record<string, string>;
  timeoutMs?: number;
  /** A process whose stdout becomes this one's stdin. */
  stdin?: NodeJS.ReadableStream;
  /** Redacted out of anything captured. */
  secrets?: Array<string | undefined>;
}

/**
 * The environment a child process gets.
 *
 * Deliberately not `process.env`: that holds the database password, the
 * session secret and the SMTP credentials, and a backup process has no
 * business being able to read any of them.
 */
function childEnv(extra?: Record<string, string>): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
    HOME: process.env.HOME ?? "/tmp",
    LANG: "C.UTF-8",
    NODE_ENV: process.env.NODE_ENV,
    ...extra,
  };
}

function tail(text: string): string {
  return text.length > MAX_OUTPUT_BYTES ? `…${text.slice(-MAX_OUTPUT_BYTES)}` : text;
}

/** Run a command to completion. */
function run(command: string, args: string[], options: RunOptions = {}): Promise<RunResult> {
  const { timeoutMs = QUICK_TIMEOUT_MS, secrets = [] } = options;

  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env: childEnv(options.env),
      stdio: ["pipe", "pipe", "pipe"],
    });

    // Nothing is being piped in, so close stdin at once rather than leaving the
    // child waiting on input that will never come.
    if (!options.stdin) child.stdin.end();

    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      // A borg holding a lock deserves a moment to let go of it before SIGKILL.
      setTimeout(() => child.kill("SIGKILL"), 10_000).unref();
    }, timeoutMs);
    timer.unref();

    child.stdout?.on("data", (chunk) => {
      stdout += chunk;
      if (stdout.length > MAX_OUTPUT_BYTES * 8) stdout = stdout.slice(-MAX_OUTPUT_BYTES * 8);
    });
    child.stderr?.on("data", (chunk) => {
      stderr += chunk;
      if (stderr.length > MAX_OUTPUT_BYTES * 8) stderr = stderr.slice(-MAX_OUTPUT_BYTES * 8);
    });

    if (options.stdin) {
      // EPIPE here is normal: it means the child stopped reading, and the
      // child's own exit code is the thing worth reporting. Unhandled, it
      // would take the server down.
      child.stdin.on("error", () => {});
      options.stdin.pipe(child.stdin);
    }

    child.on("error", (err) => {
      clearTimeout(timer);
      // ENOENT: the binary isn't in the image. Reported as an exit code the
      // diagnosis already understands rather than as a Node error object.
      reject(
        new BorgCommandError({
          command: `${command} ${args[0] ?? ""}`.trim(),
          exitCode: (err as NodeJS.ErrnoException).code === "ENOENT" ? 127 : null,
          stderr: redact(String(err instanceof Error ? err.message : err), secrets),
        }),
      );
    });

    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolve({
        stdout: redact(tail(stdout), secrets),
        stderr: redact(tail(stderr), secrets),
        // A timeout kills the process, which reports as a signal rather than a
        // code. Passed through as null so the diagnosis can tell the two apart.
        exitCode: timedOut ? null : code,
      });
      if (signal && !timedOut) {
        // Killed by something other than our own timeout — recorded in stderr
        // so it isn't mistaken for a clean exit.
        stderr += `\nkilled by ${signal}`;
      }
    });
  });
}

/** Run a borg command, turning a non-zero exit into a BorgCommandError. */
async function borg(
  config: BorgConfig,
  args: string[],
  options: { timeoutMs?: number; stdin?: NodeJS.ReadableStream } = {},
): Promise<RunResult> {
  const result = await run("borg", args, {
    env: borgEnv(config),
    secrets: [config.passphrase],
    ...options,
  });

  // A warning means the archive was written. Failing here would retry a good
  // backup on every tick — see isWarningExit.
  if (result.exitCode !== 0 && !isWarningExit(result.exitCode)) {
    throw new BorgCommandError({
      command: `borg ${args[0]}`,
      exitCode: result.exitCode,
      stderr: result.stderr || result.stdout,
    });
  }

  return result;
}

/** Create the key's directory and borg's cache directory, both private. */
async function ensureStateDirs(config: BorgConfig): Promise<void> {
  await mkdir(dirname(config.sshKeyPath), { recursive: true, mode: 0o700 });
  await mkdir(config.baseDir, { recursive: true, mode: 0o700 });
}

export interface SshKeyInfo {
  path: string;
  /** The `ssh-ed25519 AAAA… mealplanner-backup` line to install on the host. */
  publicKey: string;
  /** e.g. "SHA256:abc…" — for comparing against what the host shows. */
  fingerprint: string;
  /** True when this call created it rather than finding it. */
  created: boolean;
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * The key this instance connects with, generating one if there isn't one yet.
 *
 * Generating it here rather than asking someone to run ssh-keygen is most of
 * what makes this setup short: the household copies one line out of a settings
 * screen into their storage box and never touches a terminal.
 *
 * ed25519 with no passphrase — an unattended backup has nobody to type one,
 * and a passphrase-less key whose only privilege is writing to a backup
 * repository is the ordinary trade. Its safety comes from the storage box
 * accepting it for nothing else.
 */
export async function ensureSshKey(config: BorgConfig): Promise<SshKeyInfo> {
  await ensureStateDirs(config);

  const created = !(await exists(config.sshKeyPath));
  if (created) {
    const result = await run("ssh-keygen", [
      "-t", "ed25519",
      "-N", "",
      "-C", "mealplanner-backup",
      "-f", config.sshKeyPath,
    ]);
    if (result.exitCode !== 0) {
      throw new BorgCommandError({
        command: "ssh-keygen",
        exitCode: result.exitCode,
        stderr: result.stderr || result.stdout,
      });
    }
  }

  const publicKey = (await readFile(`${config.sshKeyPath}.pub`, "utf8")).trim();
  const fingerprint = await run("ssh-keygen", ["-lf", `${config.sshKeyPath}.pub`])
    .then((r) => r.stdout.trim())
    .catch(() => "");

  return { path: config.sshKeyPath, publicKey, fingerprint, created };
}

/** The public key if one has been generated, else null. Never generates. */
export async function readPublicKey(config: BorgConfig): Promise<SshKeyInfo | null> {
  if (!(await exists(`${config.sshKeyPath}.pub`))) return null;
  const publicKey = (await readFile(`${config.sshKeyPath}.pub`, "utf8")).trim();
  const fingerprint = await run("ssh-keygen", ["-lf", `${config.sshKeyPath}.pub`])
    .then((r) => r.stdout.trim())
    .catch(() => "");
  return { path: config.sshKeyPath, publicKey, fingerprint, created: false };
}

/** The installed borg's version line, or null if there's no borg to ask. */
export async function borgVersion(): Promise<string | null> {
  try {
    const result = await run("borg", ["--version"], { timeoutMs: 30_000 });
    return result.exitCode === 0 ? result.stdout.trim() : null;
  } catch {
    return null;
  }
}

/** The installed pg_dump's version line, or null. */
export async function pgDumpVersion(): Promise<string | null> {
  try {
    const result = await run("pg_dump", ["--version"], { timeoutMs: 30_000 });
    return result.exitCode === 0 ? result.stdout.trim() : null;
  } catch {
    return null;
  }
}

export interface RepoInfo {
  /** Bytes this repository occupies on the far end, after deduplication. */
  uniqueSize: number | null;
  /** What every archive would add up to unpacked. */
  totalSize: number | null;
  location: string | null;
}

/**
 * Repository totals — and the cheapest proof that the whole path works: key,
 * network, host, passphrase and repository, in one round trip.
 */
export async function repoInfo(config: BorgConfig): Promise<RepoInfo> {
  await ensureStateDirs(config);
  const { stdout } = await borg(config, infoArgs(config));

  try {
    const parsed = JSON.parse(stdout);
    const cache = parsed?.cache?.stats ?? {};
    return {
      // Borg renamed these between versions; whichever is present is read, and
      // a missing one shows as "unknown" rather than as zero.
      uniqueSize: numberOrNull(cache.unique_csize ?? cache.unique_size),
      totalSize: numberOrNull(cache.total_size ?? cache.total_csize),
      location: parsed?.repository?.location ?? null,
    };
  } catch {
    return { uniqueSize: null, totalSize: null, location: null };
  }
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export interface ArchiveSummary {
  name: string;
  /** ISO instant the archive was written. */
  time: string | null;
}

/** The archives this app has written, oldest first. */
export async function listArchives(config: BorgConfig, last = 20): Promise<ArchiveSummary[]> {
  await ensureStateDirs(config);
  const { stdout } = await borg(config, listArgs(config, last));
  try {
    const parsed = JSON.parse(stdout);
    const archives: unknown[] = Array.isArray(parsed?.archives) ? parsed.archives : [];
    return archives.map((entry) => {
      const a = entry as { name?: string; time?: string; start?: string };
      return { name: a.name ?? "(unnamed)", time: a.time ?? a.start ?? null };
    });
  } catch {
    return [];
  }
}

/**
 * Write one archive from a stream of SQL.
 *
 * Split out of runBackup so the borg half — repository, key, encryption,
 * archive naming — can be exercised against a scratch repository without a
 * Postgres to dump (see borg.integration.test.mjs). It is the same call the
 * nightly backup makes, not a parallel one written for the test.
 */
export async function createArchive(
  config: BorgConfig,
  archive: string,
  sql: NodeJS.ReadableStream,
): Promise<RunResult> {
  return borg(config, createArgs(config, archive), { stdin: sql, timeoutMs: CREATE_TIMEOUT_MS });
}

/** Apply retention, then free what it dropped. Returns anything borg complained about. */
export async function pruneAndCompact(config: BorgConfig): Promise<string> {
  let warnings = "";
  for (const [label, args] of [
    ["prune", pruneArgs(config)],
    ["compact", compactArgs(config)],
  ] as const) {
    try {
      const result = await borg(config, args, { timeoutMs: CREATE_TIMEOUT_MS });
      if (result.stderr.trim()) warnings += `\n${label}: ${result.stderr.trim()}`;
    } catch (err) {
      const failure = err instanceof BorgCommandError ? err.failure.stderr : String(err);
      warnings += `\n${label} failed after the archive was written: ${failure}`;
    }
  }
  return warnings;
}

/** Create the repository. Only ever creates — borg refuses to overwrite one. */
export async function initRepo(config: BorgConfig): Promise<void> {
  await ensureStateDirs(config);
  await borg(config, initArgs(config), { timeoutMs: QUICK_TIMEOUT_MS });
}

export interface BackupResult {
  archive: string;
  /** The dump's size before compression and deduplication. */
  originalBytes: number | null;
  compressedBytes: number | null;
  /** What this archive actually added to the repository. Usually tiny. */
  dedupedBytes: number | null;
  /** Non-fatal complaints from borg: the archive exists either way. */
  warnings: string;
}

/**
 * Take a backup: dump the database into a new archive, then prune and compact.
 *
 * The dump is streamed straight into borg rather than staged on disk — writing
 * a copy of the database to the box whose disk you're hedging against is both
 * the slowest option and the one that fails when it's most needed.
 *
 * The subtle part is what happens when pg_dump dies halfway. Its stdout closes,
 * borg sees a clean end of stream, and writes a perfectly valid archive
 * containing half a database — a backup that looks fine in every listing until
 * someone restores from it. So pg_dump's exit code is checked after borg's, and
 * a bad dump takes its archive back out of the repository. A backup that failed
 * is recoverable; one that lies is not.
 */
export async function runBackup(
  config: BorgConfig,
  databaseUrl: string,
  now: Date = new Date(),
): Promise<BackupResult> {
  await ensureStateDirs(config);

  const archive = archiveName(now);
  const dumpArgs = pgDumpArgs(databaseUrl);

  const dump = spawn("pg_dump", dumpArgs, {
    env: childEnv(),
    stdio: ["ignore", "pipe", "pipe"],
  });

  let dumpStderr = "";
  dump.stderr.on("data", (chunk) => {
    dumpStderr += chunk;
    if (dumpStderr.length > MAX_OUTPUT_BYTES) dumpStderr = dumpStderr.slice(-MAX_OUTPUT_BYTES);
  });

  const dumpExit = new Promise<{ code: number | null; error?: Error }>((resolve) => {
    dump.on("error", (error) => resolve({ code: 127, error }));
    dump.on("close", (code) => resolve({ code }));
  });

  let created: RunResult;
  try {
    created = await createArchive(config, archive, dump.stdout);
  } catch (err) {
    // Don't leave pg_dump running against the database after borg has gone.
    dump.kill("SIGTERM");
    const { code } = await dumpExit;
    // If the dump was the thing that failed, its message is the useful one:
    // borg only ever saw a stream that ended early.
    if (code !== 0 && dumpStderr.trim()) {
      throw new BorgCommandError({ command: "pg_dump", exitCode: code, stderr: dumpStderr });
    }
    throw err;
  }

  const { code: dumpCode, error: dumpError } = await dumpExit;
  if (dumpCode !== 0) {
    // The archive holds a truncated dump. Take it back out before anything
    // records this as a successful backup.
    let removal = "";
    try {
      await borg(config, deleteArchiveArgs(config, archive));
    } catch {
      removal = ` The incomplete archive ${archive} could not be removed; delete it by hand.`;
    }

    throw new BorgCommandError({
      command: "pg_dump",
      exitCode: dumpCode,
      stderr:
        (dumpStderr.trim() || dumpError?.message || "pg_dump exited without a message.") +
        `\nThe archive it was writing into was discarded, because it would have held only part of the database.${removal}`,
    });
  }

  const stats = parseCreateStats(created.stdout);

  // Retention, then the compaction that actually frees what retention dropped.
  // Both are recorded as warnings rather than failures: the archive is already
  // safe, and a repository one prune behind is not an emergency.
  const warnings = created.stderr.trim() + (await pruneAndCompact(config));

  return { archive, ...stats, warnings: warnings.trim() };
}

/** Read what `borg create --json` reported, tolerating version differences. */
function parseCreateStats(stdout: string): Omit<BackupResult, "archive" | "warnings"> {
  try {
    const stats = JSON.parse(stdout)?.archive?.stats ?? {};
    return {
      originalBytes: numberOrNull(stats.original_size),
      compressedBytes: numberOrNull(stats.compressed_size),
      dedupedBytes: numberOrNull(stats.deduplicated_size),
    };
  } catch {
    return { originalBytes: null, compressedBytes: null, dedupedBytes: null };
  }
}
