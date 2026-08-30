// End-to-end test of the borg half of a backup (§11). Run with `npm test`.
//
// Everything else about backups is tested against argument lists and stderr
// fragments, which is the only way to test a storage box you don't want to
// talk to in a unit test. This one does the real thing — creates a repository,
// writes an encrypted archive, reads it back, prunes it — against a scratch
// directory, so the claim "these commands work" is checked rather than
// asserted.
//
// It needs borg on PATH and skips itself without one, because a laptop that
// has never installed borg should still get a green `npm test`. The box that
// runs the backups has borg by definition (the Dockerfile installs it), which
// is where this matters.

import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";

import { DUMP_NAME, readBorgConfig } from "./borgConfig.ts";
import { createArchive, initRepo, listArchives, pruneAndCompact, repoInfo } from "./borg.ts";

function borgInstalled() {
  try {
    execFileSync("borg", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const SKIP = borgInstalled() ? false : "borg is not installed on this machine";

test("a repository can be created, written to, read back and pruned", { skip: SKIP }, async (t) => {
  const scratch = await mkdtemp(join(tmpdir(), "mealplanner-borg-"));
  t.after(() => rm(scratch, { recursive: true, force: true }));

  const { config } = readBorgConfig({
    // A local path rather than ssh://, so the test needs no network and no key.
    BORG_REPO: join(scratch, "repo"),
    BORG_PASSPHRASE: "a passphrase for the test repository",
    BACKUP_STATE_DIR: join(scratch, "state"),
    BACKUP_KEEP_DAILY: "1",
    BACKUP_KEEP_WEEKLY: "0",
    BACKUP_KEEP_MONTHLY: "0",
  });

  await initRepo(config);

  // A stand-in for pg_dump's output: the point here is the borg pipeline, not
  // the SQL. Compressible and repetitive, like a real dump.
  const sql = "CREATE TABLE recipe (id text primary key);\n".repeat(500);
  const created = await createArchive(config, "mealplanner-2026-08-30T01-00-00Z", Readable.from(sql));
  assert.equal(created.exitCode, 0, created.stderr);

  const archives = await listArchives(config);
  assert.equal(archives.length, 1);
  assert.equal(archives[0].name, "mealplanner-2026-08-30T01-00-00Z");

  // The archive is real: extract it and get the bytes back.
  const extracted = execFileSync(
    "borg",
    ["extract", "--stdout", `${join(scratch, "repo")}::mealplanner-2026-08-30T01-00-00Z`, DUMP_NAME],
    { env: { ...process.env, BORG_PASSPHRASE: "a passphrase for the test repository" }, maxBuffer: 10 << 20 },
  ).toString();
  assert.equal(extracted, sql, "what comes out of the archive must be what went in");

  const info = await repoInfo(config);
  assert.ok(info.uniqueSize === null || info.uniqueSize > 0);

  // A second archive of the same content should cost almost nothing, which is
  // the entire reason a nightly full dump is affordable.
  const before = (await repoInfo(config)).uniqueSize;
  await createArchive(config, "mealplanner-2026-08-31T01-00-00Z", Readable.from(sql));
  const after = (await repoInfo(config)).uniqueSize;
  if (before !== null && after !== null) {
    assert.ok(
      after - before < sql.length / 2,
      `deduplication didn't happen: repository grew by ${after - before} bytes for ${sql.length} bytes of identical SQL`,
    );
  }

  // Retention keeps one daily, and prune only ever matches this app's prefix.
  await pruneAndCompact(config);
  const kept = await listArchives(config);
  assert.equal(kept.length, 1, "prune should have kept exactly one daily archive");
  assert.equal(kept[0].name, "mealplanner-2026-08-31T01-00-00Z", "the newest is the one kept");
});

test("prune leaves archives it didn't write alone", { skip: SKIP }, async (t) => {
  const scratch = await mkdtemp(join(tmpdir(), "mealplanner-borg-"));
  t.after(() => rm(scratch, { recursive: true, force: true }));

  const repo = join(scratch, "repo");
  const { config } = readBorgConfig({
    BORG_REPO: repo,
    BORG_PASSPHRASE: "a passphrase for the test repository",
    BACKUP_STATE_DIR: join(scratch, "state"),
    BACKUP_KEEP_DAILY: "1",
    BACKUP_KEEP_WEEKLY: "0",
    BACKUP_KEEP_MONTHLY: "0",
  });
  const env = { ...process.env, BORG_PASSPHRASE: "a passphrase for the test repository" };

  await initRepo(config);
  await createArchive(config, "mealplanner-2026-08-30T01-00-00Z", Readable.from("one"));
  await createArchive(config, "mealplanner-2026-08-31T01-00-00Z", Readable.from("two"));

  // Something else's archive, in the same repository.
  execFileSync("borg", ["create", "--stdin-name", "other.txt", `${repo}::someone-elses-backup`, "-"], {
    input: "not ours",
    env,
  });

  await pruneAndCompact(config);

  const everything = execFileSync("borg", ["list", "--short", repo], { env }).toString();
  assert.match(everything, /someone-elses-backup/, "prune must not touch archives it didn't create");
  assert.match(everything, /mealplanner-2026-08-31T01-00-00Z/);
  assert.doesNotMatch(everything, /mealplanner-2026-08-30T01-00-00Z/, "the older daily should be gone");
});
