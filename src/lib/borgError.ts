/**
 * Turning a borg or pg_dump failure into something actionable (§11).
 *
 * A failed backup reports itself as an exit code and a paragraph of stderr,
 * and neither says what to go and change. "Permission denied (publickey)" is
 * really "the storage box has never been told about this key"; "Repository
 * does not exist" is really "you haven't pressed Create the repository yet".
 * This maps the handful that actually happen onto the thing to do about them.
 *
 * Pure and dependency-free, like src/lib/mailError.ts: pass in the shape a
 * failed child process produces, get a sentence back — no borg required to
 * test it, which matters because these are precisely the paths that are hard
 * to reproduce on purpose.
 */

import { describeRepo } from "./borgConfig.ts";

export interface BorgFailure {
  /** What was being attempted, e.g. "borg create" — used in the summary. */
  command: string;
  exitCode: number | null;
  /** Set when the process was killed rather than exiting, e.g. on timeout. */
  signal?: string | null;
  stderr: string;
}

export interface BorgDiagnosis {
  /** One line naming the likely cause. */
  summary: string;
  /** What to change, when we can be specific about it. */
  hint?: string;
  /** The raw detail, always passed through so nothing is hidden. */
  detail: string;
}

/**
 * Whether an exit code means "finished, with complaints" rather than "failed".
 *
 * Borg has two exit-code schemes. The old one is 0 success, 1 warning, 2 error.
 * The modern one — asked for by BORG_EXIT_CODES=modern, and ignored by versions
 * that predate it — keeps 2-99 for errors and moves warnings to 100 and up.
 * Both are accepted here, because which one is in force depends on a borg
 * version this app doesn't choose.
 *
 * The distinction is not cosmetic: a warning means the archive was written and
 * the household is backed up. Treating it as a failure would retry a good
 * backup every fifteen minutes and light up the settings screen in red.
 */
export function isWarningExit(exitCode: number | null): boolean {
  return exitCode === 1 || (exitCode !== null && exitCode >= 100);
}

/** Blank out anything secret before a string reaches a log or a screen. */
export function redact(text: string, secrets: Array<string | undefined>): string {
  let out = text;
  for (const secret of secrets) {
    if (secret && secret.length >= 4) out = out.split(secret).join("***");
  }
  return out;
}

const has = (haystack: string, pattern: RegExp) => pattern.test(haystack);

export function describeBorgFailure(
  failure: BorgFailure,
  context: { repo?: string } = {},
): BorgDiagnosis {
  const err = failure.stderr ?? "";
  const detail =
    [failure.command, failure.exitCode === null ? failure.signal : `exit ${failure.exitCode}`]
      .filter(Boolean)
      .join(" · ") + (err.trim() ? `\n${err.trim()}` : "");

  const repo = context.repo ? describeRepo(context.repo) : undefined;
  const storageBox = repo?.host?.endsWith(".your-storagebox.de") ?? false;

  // Killed rather than exited — the run outlasted its timeout.
  if (failure.exitCode === null) {
    return {
      summary: "The backup was still running when it ran out of time, so it was stopped.",
      hint: "The first backup uploads everything and can take a while on a slow line; later ones send only what changed. If it keeps happening, run it by hand from the settings screen and watch how far it gets.",
      detail,
    };
  }

  // The app has never generated its key.
  //
  // Checked before anything else about SSH, because ssh reports it *alongside*
  // "Permission denied (publickey)" — and that second line would otherwise send
  // someone to the storage box's authorised-keys screen to install a key that
  // doesn't exist yet.
  if (has(err, /Identity file [^\n]*(not accessible|No such file)/i)) {
    return {
      summary: "This instance hasn't got an SSH key to connect with yet.",
      hint: "Use Generate a key on this screen, then add the public key it shows to the backup host.",
      detail,
    };
  }

  // The binary isn't in the image at all.
  //
  // Matched narrowly — on the shell's own "not found", or on the exit code
  // reserved for it — since "No such file or directory" on its own is a line a
  // dozen unrelated failures print.
  if (failure.exitCode === 127 || has(err, /(?:^|\n)[a-z/]*sh: [^\n]*(borg|pg_dump)[^\n]*not found/i)) {
    return {
      summary: "The backup tools aren't installed in the running container.",
      hint: "borg and pg_dump are installed by the Dockerfile. A container built before backups existed won't have them: rebuild with `docker compose up -d --build`.",
      detail,
    };
  }

  // SSH: the key isn't trusted by the far end.
  if (has(err, /Permission denied \(publickey|Permission denied, please try again|no matching host key/i)) {
    return {
      summary: "The storage box refused the SSH key.",
      hint: storageBox
        ? "Copy the public key shown on this screen into the Storage Box's authorised keys (Hetzner console → Storage Box → SSH keys, or `ssh-copy-id -p 23 …`), then check again."
        : "The public key shown on this screen has to be in ~/.ssh/authorized_keys on the backup host.",
      detail,
    };
  }

  // SSH: the host key doesn't match what was pinned on first use.
  if (has(err, /REMOTE HOST IDENTIFICATION HAS CHANGED|Host key verification failed/i)) {
    return {
      summary: "The backup host is presenting a different SSH key than the one first trusted.",
      hint: "That happens legitimately when the provider rebuilds a machine — and is also what an interception looks like. Verify the new fingerprint with your provider, then remove the old line from known_hosts inside the app container.",
      detail,
    };
  }

  // The name doesn't resolve, or nothing answers at the port.
  if (has(err, /Could not resolve hostname|Name or service not known|Temporary failure in name resolution/i)) {
    return {
      summary: "That backup host doesn't resolve from inside the app container.",
      hint: "Check the hostname in BORG_REPO for a typo, and that the container has working DNS — a name that resolves on the box doesn't always resolve in the container.",
      detail,
    };
  }

  if (has(err, /Connection refused|Connection timed out|Network is unreachable/i)) {
    return {
      summary: "Nothing accepted an SSH connection at that host and port.",
      hint: storageBox || repo?.port === undefined
        ? "A Hetzner Storage Box listens on port 23, not the default 22 — BORG_REPO needs ssh://user@host:23/./path."
        : "Check the port in BORG_REPO, and that the host allows SSH from this box.",
      detail,
    };
  }

  // Borg isn't installed on the far end.
  if (has(err, /Remote:.*(command not found|No such file)|borg serve/i) && has(err, /not found/i)) {
    return {
      summary: "The backup host answered, but has no borg to talk to.",
      hint: storageBox
        ? "Hetzner Storage Boxes support borg on port 23 — check the repository URL uses that port rather than 22."
        : "borg has to be installed on the backup host too; it runs `borg serve` there.",
      detail,
    };
  }

  // The repository hasn't been created yet.
  // Anchored on "Repository", because pg_dump says "does not exist" about a
  // missing database and that is a different problem with a different fix.
  if (has(err, /Repository[^\n]*(does not exist|not found)|InvalidRepository|does not exist[^\n]*Repository/i)) {
    return {
      summary: "There's no borg repository at that location yet.",
      hint: "Use Create the repository on this screen — it runs `borg init` once, and only ever creates, never overwrites.",
      detail,
    };
  }

  // Trying to create one that's already there.
  if (has(err, /A repository already exists|repository already exists/i)) {
    return {
      summary: "There's already a repository at that location.",
      hint: "Nothing was changed. If it's this household's, you're set up already — press Check setup. If it's something else's, point BORG_REPO at a path of its own.",
      detail,
    };
  }

  // The passphrase doesn't match the one the repository was created with.
  if (has(err, /passphrase.*(incorrect|wrong)|Wrong passphrase|IntegrityError.*key|Invalid password/i)) {
    return {
      summary: "The repository won't unlock with this passphrase.",
      hint: "BORG_PASSPHRASE has to stay exactly what it was when the repository was created — changing it doesn't re-encrypt anything, it just stops the archives opening. If it was changed, put the old value back.",
      detail,
    };
  }

  // A previous run died holding the lock.
  if (has(err, /Failed to create\/acquire the lock|LockTimeout|lock.*(held|acquire)/i)) {
    return {
      summary: "The repository is locked by a run that never finished.",
      hint: "Usually a backup that was interrupted mid-upload. Once you're sure nothing is running, clear it with `docker compose exec app borg break-lock`.",
      detail,
    };
  }

  // The repository moved, or was reached by a different URL than last time.
  if (has(err, /Warning: The repository at location|previously located at|relocated/i)) {
    return {
      summary: "This repository was last reached at a different address.",
      hint: "Expected if you moved the repository or changed the URL — the app refuses it by default rather than guessing. Confirm it's the same repository, then re-run with BORG_RELOCATED_REPO_ACCESS_IS_OK=yes set for one run.",
      detail,
    };
  }

  // Out of space at the far end.
  if (has(err, /No space left on device|Disk quota exceeded|quota/i)) {
    return {
      summary: "The backup host is out of space.",
      hint: "Retention keeps a week of nightly archives, four weekly and six monthly; lowering BACKUP_KEEP_* frees space at the next prune. Note that space only returns after `borg compact`, which runs at the end of every backup.",
      detail,
    };
  }

  // A borg whose command names moved (borg 2 renamed init and --glob-archives).
  if (has(err, /unrecognized arguments|invalid choice|no such option/i)) {
    return {
      summary: "This borg doesn't recognise the commands the app is using.",
      hint: "The app targets borg 1.2-1.4. Borg 2 renamed `init` to `repo-create` and `--glob-archives` to `--match-archives`; pin borg 1.4 in the image, or update src/lib/borgConfig.ts.",
      detail,
    };
  }

  // pg_dump: the client is older than the server.
  if (has(err, /server version mismatch|server version: .*pg_dump version:/i)) {
    return {
      summary: "The pg_dump in the container is older than the Postgres it's dumping.",
      hint: "pg_dump refuses to dump a newer server. Install a client matching the db image's major version in the Dockerfile.",
      detail,
    };
  }

  // pg_dump: it never got to the database.
  if (has(err, /password authentication failed|role .* does not exist|database .* does not exist/i)) {
    return {
      summary: "pg_dump reached Postgres but couldn't sign in.",
      hint: "The backup uses DATABASE_URL, the same string the app runs on — check the user, password and database name in it.",
      detail,
    };
  }

  if (has(err, /could not connect to server|could not translate host name|the database system is starting up/i)) {
    return {
      summary: "pg_dump couldn't reach Postgres.",
      hint: "The database container may still be starting. If it persists, check DATABASE_URL points at the `db` service rather than localhost — inside the app container, localhost is the app.",
      detail,
    };
  }

  return {
    summary: `${failure.command} failed.`,
    hint: "The raw output below is what it said.",
    detail,
  };
}
