// Tests for the backup settings and the commands they build (§11).
// Run with `npm test`.
//
// These assert the argument lists borg is actually handed. It's the part of a
// backup nobody looks at until a restore, and the part where a mistake is
// silent: an archive nobody prunes, a prune that matches somebody else's
// archives, a dump compressed before it's deduplicated.

import test from "node:test";
import assert from "node:assert/strict";

import {
  ARCHIVE_PREFIX,
  DEFAULT_RETENTION,
  DUMP_NAME,
  archiveName,
  borgEnv,
  compactArgs,
  createArgs,
  describeRepo,
  infoArgs,
  initArgs,
  knownHostsPath,
  isBackupConfigured,
  listArgs,
  pruneArgs,
  readBorgConfig,
  restoreCommands,
  sshCommand,
} from "./borgConfig.ts";

const REPO = "ssh://u12345@u12345.your-storagebox.de:23/./mealplanner";
const FULL_ENV = { BORG_REPO: REPO, BORG_PASSPHRASE: "correct horse battery staple" };

const config = () => readBorgConfig(FULL_ENV).config;

test("an unconfigured instance names what's missing rather than throwing", () => {
  const { missing, config } = readBorgConfig({});
  assert.deepEqual(missing, ["BORG_REPO", "BORG_PASSPHRASE"]);
  // Still a usable object: the settings screen has to render for the very
  // household that hasn't set this up yet.
  assert.equal(config.repo, "");
  assert.deepEqual(config.retention, DEFAULT_RETENTION);
  assert.equal(isBackupConfigured({}), false);
});

test("a repository without a passphrase is not configured", () => {
  const { missing } = readBorgConfig({ BORG_REPO: REPO });
  assert.deepEqual(missing, ["BORG_PASSPHRASE"]);
});

test("both present is configured", () => {
  assert.deepEqual(readBorgConfig(FULL_ENV).missing, []);
  assert.equal(isBackupConfigured(FULL_ENV), true);
});

test("the key and cache default to a directory meant to outlive the container", () => {
  const c = config();
  assert.equal(c.sshKeyPath, "/var/lib/mealplanner/ssh/id_ed25519");
  assert.equal(c.baseDir, "/var/lib/mealplanner/borg");
});

test("the state directory can be moved, and both paths follow it", () => {
  const c = readBorgConfig({ ...FULL_ENV, BACKUP_STATE_DIR: "/data" }).config;
  assert.equal(c.sshKeyPath, "/data/ssh/id_ed25519");
  assert.equal(c.baseDir, "/data/borg");
});

test("either path can also be set on its own", () => {
  const c = readBorgConfig({
    ...FULL_ENV,
    BACKUP_SSH_KEY: "/keys/borg_ed25519",
    BORG_BASE_DIR: "/cache/borg",
  }).config;
  assert.equal(c.sshKeyPath, "/keys/borg_ed25519");
  assert.equal(c.baseDir, "/cache/borg");
});

test("retention is read from the environment, and nonsense falls back loudly", () => {
  const good = readBorgConfig({ ...FULL_ENV, BACKUP_KEEP_DAILY: "14", BACKUP_KEEP_MONTHLY: "0" });
  assert.equal(good.config.retention.daily, 14);
  assert.equal(good.config.retention.monthly, 0);
  assert.deepEqual(good.problems, []);

  const bad = readBorgConfig({ ...FULL_ENV, BACKUP_KEEP_WEEKLY: "-3" });
  assert.equal(bad.config.retention.weekly, DEFAULT_RETENTION.weekly);
  assert.match(bad.problems[0], /BACKUP_KEEP_WEEKLY/);
});

test("the scheduler is on unless it's explicitly off", () => {
  assert.equal(config().schedulerEnabled, true);
  assert.equal(readBorgConfig({ ...FULL_ENV, BACKUP_SCHEDULER: "OFF" }).config.schedulerEnabled, false);
  assert.equal(readBorgConfig({ ...FULL_ENV, BACKUP_SCHEDULER: "on" }).config.schedulerEnabled, true);
});

test("the container's TZ is the fallback zone, so backup times match the logs", () => {
  const c = readBorgConfig({ ...FULL_ENV, TZ: "America/New_York" }).config;
  assert.equal(c.schedule.timeZone, "America/New_York");
  // An explicit setting still wins.
  const explicit = readBorgConfig({ ...FULL_ENV, TZ: "America/New_York", BACKUP_TIMEZONE: "UTC" }).config;
  assert.equal(explicit.schedule.timeZone, "UTC");
});

test("a Storage Box on the default SSH port is flagged, because 23 is the one that works", () => {
  const d = describeRepo("ssh://u12345@u12345.your-storagebox.de/./mealplanner");
  assert.equal(d.kind, "ssh");
  assert.equal(d.host, "u12345.your-storagebox.de");
  assert.match(d.problem, /port 23/);
});

test("a Storage Box path that isn't relative is flagged", () => {
  const d = describeRepo("ssh://u12345@u12345.your-storagebox.de:23/mealplanner");
  assert.match(d.problem, /relative to your home directory/);
});

test("a correct Storage Box URL has nothing to complain about", () => {
  const d = describeRepo(REPO);
  assert.equal(d.problem, undefined);
  assert.equal(d.user, "u12345");
  assert.equal(d.port, 23);
  assert.equal(d.path, "/./mealplanner");
});

test("an scp-style address is caught, since borg wants a URL", () => {
  const d = describeRepo("u12345@u12345.your-storagebox.de:mealplanner");
  assert.match(d.problem, /ssh:\/\/user@host:port/);
});

test("a plain path is a local repository, not a mistake", () => {
  const d = describeRepo("/mnt/usb/mealplanner");
  assert.equal(d.kind, "local");
  assert.equal(d.problem, undefined);
  assert.equal(d.path, "/mnt/usb/mealplanner");
});

test("ssh runs without a terminal, so it must never stop to ask a question", () => {
  const command = sshCommand(config());
  assert.match(command, /BatchMode=yes/);
  assert.match(command, /StrictHostKeyChecking=accept-new/);
  assert.match(command, /-i \/var\/lib\/mealplanner\/ssh\/id_ed25519/);
});

test("the trusted host key is remembered somewhere that survives a rebuild", () => {
  // accept-new only means anything if what it accepted is still there next
  // time. Under $HOME in a container it wouldn't be, and every restart would
  // trust whatever answered.
  assert.match(sshCommand(config()), /UserKnownHostsFile=\/var\/lib\/mealplanner\/ssh\/known_hosts/);
  assert.equal(knownHostsPath(config()), "/var/lib/mealplanner/ssh/known_hosts");

  const moved = readBorgConfig({ ...FULL_ENV, BACKUP_SSH_KEY: "/keys/borg_ed25519" }).config;
  assert.equal(knownHostsPath(moved), "/keys/known_hosts");
});

test("the passphrase goes in the environment, never on a command line", () => {
  const env = borgEnv(config());
  assert.equal(env.BORG_PASSPHRASE, "correct horse battery staple");

  // `ps` shows argv to every process on the box; it doesn't show another
  // process's environment.
  const everyArgument = [
    ...initArgs(config()),
    ...createArgs(config(), "mealplanner-x"),
    ...pruneArgs(config()),
    ...listArgs(config()),
    ...infoArgs(config()),
    ...compactArgs(config()),
  ].join(" ");
  assert.doesNotMatch(everyArgument, /correct horse/);
});

test("every prompt borg could raise is answered in advance", () => {
  // Each of these is a question asked on a terminal that doesn't exist here.
  // Unanswered, they hang the nightly run rather than failing it.
  const env = borgEnv(config());
  assert.equal(env.BORG_RELOCATED_REPO_ACCESS_IS_OK, "no");
  assert.equal(env.BORG_UNKNOWN_UNENCRYPTED_REPO_ACCESS_IS_OK, "no");
});

test("archive names sort chronologically and carry nothing a shell would eat", () => {
  const earlier = archiveName(new Date("2026-08-30T01:00:00Z"));
  const later = archiveName(new Date("2026-09-01T03:04:05Z"));
  assert.equal(earlier, "mealplanner-2026-08-30T01-00-00Z");
  assert.ok(earlier < later, `${earlier} should sort before ${later}`);
  assert.ok(earlier.startsWith(ARCHIVE_PREFIX));
  assert.doesNotMatch(earlier, /[:\s'"$]/);
});

test("the repository is created with the key inside it, so the passphrase alone restores", () => {
  const args = initArgs(config());
  assert.deepEqual(args, ["init", "--encryption=repokey-blake2", REPO]);
  // keyfile encryption would leave the only key on the box being backed up.
  assert.doesNotMatch(args.join(" "), /keyfile/);
});

test("the dump is streamed in uncompressed, so borg can deduplicate it", () => {
  const args = createArgs(config(), "mealplanner-2026-08-30T01-00-00Z");
  assert.equal(args[0], "create");
  assert.equal(args.at(-1), "-", "the source must be stdin");
  assert.equal(args.at(-2), `${REPO}::mealplanner-2026-08-30T01-00-00Z`);
  assert.ok(args.includes("--stdin-name"));
  assert.equal(args[args.indexOf("--stdin-name") + 1], DUMP_NAME);
  assert.equal(args[args.indexOf("--compression") + 1], "zstd");
  // Compressing before borg sees it would defeat content-defined chunking and
  // store a fresh copy of the whole database every night.
  assert.doesNotMatch(args.join(" "), /gzip|\.gz/);
  // Machine-readable stats, so the run can be recorded rather than guessed at.
  assert.ok(args.includes("--json"));
});

test("prune only ever considers archives this app wrote", () => {
  const args = pruneArgs(config());
  assert.equal(args[args.indexOf("--glob-archives") + 1], `${ARCHIVE_PREFIX}*`);
  assert.ok(args.includes("--keep-daily=7"));
  assert.ok(args.includes("--keep-weekly=4"));
  assert.ok(args.includes("--keep-monthly=6"));
  assert.equal(args.at(-1), REPO);
});

test("retention set in the environment reaches prune", () => {
  const c = readBorgConfig({ ...FULL_ENV, BACKUP_KEEP_DAILY: "30" }).config;
  assert.ok(pruneArgs(c).includes("--keep-daily=30"));
});

test("listing is scoped to this app's archives too, newest last", () => {
  const args = listArgs(config(), 5);
  assert.ok(args.includes("--json"));
  assert.equal(args[args.indexOf("--glob-archives") + 1], `${ARCHIVE_PREFIX}*`);
  assert.equal(args[args.indexOf("--last") + 1], "5");
});

test("info and compact address the repository directly", () => {
  assert.equal(infoArgs(config()).at(-1), REPO);
  assert.equal(compactArgs(config()).at(-1), REPO);
  assert.ok(infoArgs(config()).includes("--json"));
});

test("every long-running command waits for the lock rather than failing on it", () => {
  for (const args of [createArgs(config(), "a"), pruneArgs(config()), compactArgs(config())]) {
    assert.ok(args.includes("--lock-wait"), `missing --lock-wait: ${args.join(" ")}`);
  }
});

test("the restore instructions name the file the dump was stored under", () => {
  const lines = restoreCommands("mealplanner-2026-08-30T01-00-00Z");
  assert.ok(lines.some((l) => l.includes(DUMP_NAME)));
  assert.ok(lines.some((l) => l.includes("mealplanner-2026-08-30T01-00-00Z")));
  assert.ok(lines.some((l) => l.includes("psql")));
});
