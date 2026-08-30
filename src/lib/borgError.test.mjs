// Tests for the backup failure diagnosis (§11). Run with `npm test`.
//
// Every stderr fragment here is one borg, ssh, pg_dump or the shell actually
// produces. The value of the module is entirely in getting the *right* one of
// these, so the tests lean on the pairs that are easy to confuse: an ssh key
// that was never generated versus one the far end refuses, a missing database
// versus a missing repository.

import test from "node:test";
import assert from "node:assert/strict";

import { describeBorgFailure, isWarningExit, redact } from "./borgError.ts";

const REPO = "ssh://u12345@u12345.your-storagebox.de:23/./mealplanner";

const failure = (stderr, extra = {}) => ({
  command: "borg create",
  exitCode: 2,
  stderr,
  ...extra,
});

const diagnose = (stderr, extra = {}) => describeBorgFailure(failure(stderr, extra), { repo: REPO });

test("a warning means the archive was written, so it isn't a failure", () => {
  // Borg's old scheme puts warnings at 1; BORG_EXIT_CODES=modern moves them to
  // 100 and up. Both are in the field, because the borg version isn't ours to
  // pick. Calling either a failure would retry a good backup every tick.
  assert.equal(isWarningExit(1), true);
  assert.equal(isWarningExit(100), true);
  assert.equal(isWarningExit(107), true);
  assert.equal(isWarningExit(2), false);
  assert.equal(isWarningExit(0), false);
  assert.equal(isWarningExit(null), false);
});

test("a killed process is reported as a timeout, not a mystery", () => {
  const d = describeBorgFailure(
    { command: "borg create", exitCode: null, signal: "SIGTERM", stderr: "" },
    { repo: REPO },
  );
  assert.match(d.summary, /ran out of time/);
  assert.match(d.detail, /SIGTERM/);
});

test("a container built before backups existed is told to rebuild", () => {
  const d = describeBorgFailure(
    { command: "borg create", exitCode: 127, stderr: "sh: borg: not found" },
    { repo: REPO },
  );
  assert.match(d.summary, /aren't installed/);
  assert.match(d.hint, /--build/);
});

test("a key that was never generated is not the same as a key that was refused", () => {
  // ssh prints both lines together, and the first is the one that matters:
  // there is nothing to install on the storage box yet.
  const d = diagnose(
    "Warning: Identity file /var/lib/mealplanner/ssh/id_ed25519 not accessible: No such file or directory.\n" +
      "u12345@u12345.your-storagebox.de: Permission denied (publickey).",
  );
  assert.match(d.summary, /hasn't got an SSH key/i);
  assert.doesNotMatch(d.summary, /aren't installed/);
});

test("a key the far end refuses points at the storage box's authorised keys", () => {
  const d = diagnose("u12345@u12345.your-storagebox.de: Permission denied (publickey).");
  assert.match(d.summary, /refused the SSH key/);
  assert.match(d.hint, /authorised keys|ssh-copy-id/i);
});

test("a changed host key is called out as both a rebuild and an interception", () => {
  const d = diagnose(
    "@@@ WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED! @@@\nHost key verification failed.",
  );
  assert.match(d.summary, /different SSH key/);
  assert.match(d.hint, /fingerprint/);
});

test("a hostname that doesn't resolve blames DNS in the container", () => {
  const d = diagnose("ssh: Could not resolve hostname u12345.your-storagebox.de: Name or service not known");
  assert.match(d.summary, /doesn't resolve/);
});

test("a refused connection to a Storage Box suggests port 23", () => {
  const d = diagnose("ssh: connect to host u12345.your-storagebox.de port 22: Connection refused");
  assert.match(d.summary, /Nothing accepted an SSH connection/);
  assert.match(d.hint, /port 23/);
});

test("a repository that hasn't been created points at the button that creates it", () => {
  const d = diagnose(`Repository ${REPO} does not exist.`);
  assert.match(d.summary, /no borg repository/);
  assert.match(d.hint, /Create the repository/);
});

test("a missing database is a pg_dump problem, not a missing repository", () => {
  // Both messages say "does not exist"; only one of them is about borg.
  const d = describeBorgFailure(
    {
      command: "pg_dump",
      exitCode: 1,
      stderr: 'pg_dump: error: connection to server failed: FATAL: database "mealplanner" does not exist',
    },
    { repo: REPO },
  );
  assert.match(d.summary, /pg_dump/);
  assert.doesNotMatch(d.summary, /borg repository/);
});

test("initialising over an existing repository says nothing was changed", () => {
  const d = describeBorgFailure(
    { command: "borg init", exitCode: 2, stderr: "A repository already exists at /./mealplanner." },
    { repo: REPO },
  );
  assert.match(d.summary, /already a repository/);
  assert.match(d.hint, /Nothing was changed/);
});

test("a wrong passphrase warns that changing it doesn't re-encrypt anything", () => {
  const d = diagnose(
    "Cannot open repository: passphrase supplied in BORG_PASSPHRASE or by BORG_PASSCOMMAND is incorrect.",
  );
  assert.match(d.summary, /won't unlock/);
  assert.match(d.hint, /doesn't re-encrypt/);
});

test("a stale lock comes with the command that clears it", () => {
  const d = diagnose(
    "Failed to create/acquire the lock /./mealplanner/lock.exclusive (timeout).",
  );
  assert.match(d.summary, /locked/);
  assert.match(d.hint, /break-lock/);
});

test("a full storage box explains that space only returns after compact", () => {
  const d = diagnose("OSError: [Errno 122] Disk quota exceeded");
  assert.match(d.summary, /out of space/);
  assert.match(d.hint, /compact/);
});

test("a borg whose commands were renamed names the version it expects", () => {
  const d = describeBorgFailure(
    { command: "borg init", exitCode: 2, stderr: "borg: error: argument command: invalid choice: 'init'" },
    { repo: REPO },
  );
  assert.match(d.summary, /doesn't recognise the commands/);
  assert.match(d.hint, /repo-create/);
});

test("a pg_dump older than its server says which one to install", () => {
  const d = describeBorgFailure(
    {
      command: "pg_dump",
      exitCode: 1,
      stderr: "pg_dump: error: server version: 17.2; pg_dump version: 16.4\npg_dump: error: aborting because of server version mismatch",
    },
    { repo: REPO },
  );
  assert.match(d.summary, /older than the Postgres/);
});

test("a database that refuses the login points at DATABASE_URL", () => {
  const d = describeBorgFailure(
    { command: "pg_dump", exitCode: 1, stderr: 'pg_dump: error: password authentication failed for user "mealplanner"' },
    { repo: REPO },
  );
  assert.match(d.summary, /couldn't sign in/);
  assert.match(d.hint, /DATABASE_URL/);
});

test("anything unrecognised still passes the raw output through", () => {
  const d = diagnose("something nobody has seen before");
  assert.match(d.summary, /borg create failed/);
  assert.match(d.detail, /something nobody has seen before/);
  assert.match(d.detail, /exit 2/);
});

test("the passphrase never survives into a message that gets shown or logged", () => {
  const secret = "correct horse battery staple";
  const text = `borg said ${secret} out loud`;
  assert.equal(redact(text, [secret]), "borg said *** out loud");
  // Short or absent secrets are left alone rather than blanking half the text.
  assert.equal(redact("abc", ["a"]), "abc");
  assert.equal(redact("abc", [undefined]), "abc");
});
