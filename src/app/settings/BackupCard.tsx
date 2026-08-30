"use client";

import { useCallback, useEffect, useState } from "react";
import { DiagnosisPanel, type Diagnosis } from "./Diagnosis";

/**
 * Backups, on the settings screen (§11).
 *
 * Two jobs, and the second is the one that earns the space.
 *
 * The first is setting them up, in the order a household actually does it:
 * point at a repository, pick a passphrase, install a key, create the
 * repository, take the first backup. Each step says what to do and knows
 * whether it's done, so nobody has to hold the sequence in their head or find
 * their way into a container to run ssh-keygen.
 *
 * The second is answering "are we backed up?" without a terminal. Backups fail
 * silently by nature — the archives stop and nothing looks any different — so
 * the top line of this card is a plain sentence about the last one, and it
 * turns red when the answer stops being yes.
 */

interface Run {
  id: string;
  day: string;
  trigger: "SCHEDULED" | "MANUAL";
  startedAt: string;
  finishedAt: string | null;
  ok: boolean;
  archive: string | null;
  originalBytes: number | null;
  dedupedBytes: number | null;
  error: string | null;
  warnings: string | null;
}

interface Status {
  configured: boolean;
  missing: string[];
  problems: string[];
  schedulerEnabled: boolean;
  schedule: { description: string; nextAt: string };
  retention: { daily: number; weekly: number; monthly: number };
  repo: { display: string; kind: string; host?: string; user?: string; port?: number; problem?: string };
  key: { path: string; publicKey: string; fingerprint: string } | null;
  tools: { borg: string | null; pgDump: string | null };
  dueDay: string;
  upToDate: boolean;
  lastSuccess: Run | null;
  runs: Run[];
  restore: string[];
}

type Action = "key" | "init" | "check" | "run";

export function BackupCard() {
  const [status, setStatus] = useState<Status | null>(null);
  const [busy, setBusy] = useState<Action | null>(null);
  const [result, setResult] = useState<(Diagnosis & { ok?: boolean }) | null>(null);
  const [suggested, setSuggested] = useState<string | null>(null);

  const load = useCallback(async () => {
    const res = await fetch("/api/backup");
    if (res.ok) setStatus(await res.json());
  }, []);

  useEffect(() => {
    load().catch(() => {});
  }, [load]);

  async function act(action: Action) {
    setBusy(action);
    setResult(null);
    try {
      const res = await fetch(`/api/backup/${action}`, { method: "POST" });
      const data = await res.json().catch(() => null);
      setResult(
        data ?? { summary: "The server didn't answer in a way this page could read.", detail: "" },
      );
      // Anything here can change the answer to "are we backed up?".
      await load();
    } catch {
      setResult({ summary: "Couldn't reach the server.", detail: "" });
    } finally {
      setBusy(null);
    }
  }

  /**
   * A passphrase, generated in this browser and never sent anywhere.
   *
   * It has to end up in the .env file on the box, which is somewhere only a
   * person can put it — and it must also be written down somewhere off the
   * box, because it is the one thing that makes the archives readable after
   * the box is gone. Generating it here rather than on the server keeps it out
   * of the app's logs and out of the database it protects.
   */
  function suggestPassphrase() {
    const alphabet = "abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    const bytes = new Uint8Array(32);
    crypto.getRandomValues(bytes);
    const chars = Array.from(bytes, (b) => alphabet[b % alphabet.length]);
    // Grouped, because this gets copied by hand more often than anyone expects.
    setSuggested(
      [chars.slice(0, 8), chars.slice(8, 16), chars.slice(16, 24), chars.slice(24, 32)]
        .map((group) => group.join(""))
        .join("-"),
    );
  }

  if (!status) {
    return (
      <div className="card">
        <h2>Backups</h2>
        <p className="muted">Loading…</p>
      </div>
    );
  }

  const headline = describeState(status);
  const setUp = status.configured && status.lastSuccess !== null;

  return (
    <div className="card">
      <h2>Backups</h2>

      <p style={{ margin: "0 0 4px 0", fontWeight: 600, color: headline.ok ? "inherit" : "var(--accent)" }}>
        {headline.line}
      </p>
      <p className="muted" style={{ marginTop: 0 }}>
        {status.configured
          ? status.schedulerEnabled
            ? `Every night at ${status.schedule.description}, to ${status.repo.host ?? status.repo.display}. Keeping ${status.retention.daily} daily, ${status.retention.weekly} weekly and ${status.retention.monthly} monthly archives.`
            : "The nightly schedule is switched off (BACKUP_SCHEDULER=off). Backups only happen when someone presses the button."
          : "The database holds everything: your recipes, the plan, the shopping list, every receipt photo. A home box is one failed disk away from losing all of it."}
      </p>

      {status.tools.borg === null && (
        <p style={{ color: "var(--accent)" }}>
          borg isn&rsquo;t installed in this container, so backups can&rsquo;t run at all. Rebuild
          the image with <code>docker compose up -d --build</code>.
        </p>
      )}

      {status.problems.map((problem) => (
        <p key={problem} className="muted" style={{ color: "var(--accent)" }}>
          {problem}
        </p>
      ))}

      {setUp ? (
        <details style={{ marginTop: 10 }}>
          <summary style={{ cursor: "pointer" }}>Setup — repository, passphrase and key</summary>
          <div style={{ marginTop: 10 }}>
            <SetupSteps status={status} busy={busy} act={act} suggested={suggested} suggest={suggestPassphrase} />
          </div>
        </details>
      ) : (
        <SetupSteps status={status} busy={busy} act={act} suggested={suggested} suggest={suggestPassphrase} />
      )}

      <p style={{ marginTop: 14 }}>
        <button onClick={() => act("check")} disabled={busy !== null || !status.configured}>
          {busy === "check" ? "Checking…" : "Check setup"}
        </button>{" "}
        <button onClick={() => act("run")} disabled={busy !== null || !status.configured}>
          {busy === "run" ? "Backing up…" : "Back up now"}
        </button>
      </p>
      {busy === "run" && (
        <p className="muted" style={{ fontSize: "0.85em" }}>
          The first backup uploads the whole database and can take a few minutes. Later ones send
          only what changed.
        </p>
      )}

      {result && <DiagnosisPanel d={result} ok={result.ok} />}

      {status.runs.length > 0 && (
        <details style={{ marginTop: 12 }}>
          <summary className="muted" style={{ cursor: "pointer", fontSize: "0.9em" }}>
            Recent runs
          </summary>
          <ul style={{ marginTop: 8, paddingLeft: 18 }}>
            {status.runs.map((run) => (
              <li key={run.id} style={{ marginBottom: 6 }}>
                <span style={{ color: run.ok ? "inherit" : "var(--accent)" }}>
                  {run.ok ? "✓" : "✗"} {formatWhen(run.startedAt)}
                </span>{" "}
                <span className="muted" style={{ fontSize: "0.85em" }}>
                  {run.trigger === "MANUAL" ? "by hand" : "scheduled"}
                  {run.ok && run.dedupedBytes !== null && ` · added ${formatBytes(run.dedupedBytes)}`}
                  {!run.ok && !run.finishedAt && " · interrupted"}
                </span>
                {run.error && (
                  <div className="muted" style={{ fontSize: "0.8em", whiteSpace: "pre-wrap" }}>
                    {run.error.split("\n\n")[0]}
                  </div>
                )}
              </li>
            ))}
          </ul>
        </details>
      )}

      <details style={{ marginTop: 8 }}>
        <summary className="muted" style={{ cursor: "pointer", fontSize: "0.9em" }}>
          How to restore
        </summary>
        <p className="muted" style={{ fontSize: "0.85em", marginTop: 8 }}>
          From the box, with the stack running:
        </p>
        <Code text={status.restore.join("\n")} />
        <p className="muted" style={{ fontSize: "0.85em" }}>
          If the box itself is gone, you need two things that must live somewhere else: the
          passphrase, and a way to log in to the backup host now that this box&rsquo;s key is gone
          (for a Hetzner Storage Box, the account password). With those, borg on any machine reads
          the archives — the encryption key is stored inside the repository, not here.
        </p>
      </details>
    </div>
  );
}

function SetupSteps({
  status,
  busy,
  act,
  suggested,
  suggest,
}: {
  status: Status;
  busy: Action | null;
  act: (action: Action) => void;
  suggested: string | null;
  suggest: () => void;
}) {
  const needsRepo = status.missing.includes("BORG_REPO");
  const needsPassphrase = status.missing.includes("BORG_PASSPHRASE");

  return (
    <ol style={{ paddingLeft: 20, margin: "10px 0 0 0" }}>
      <Step done={!needsRepo} title="Point it at a repository">
        {needsRepo ? (
          <>
            <p className="muted" style={{ margin: "4px 0" }}>
              Anywhere you can reach over SSH that has borg on it — a Hetzner Storage Box is the
              cheap one. Put this in the <code>.env</code> the app container reads:
            </p>
            <Code text={'BORG_REPO="ssh://u123456@u123456.your-storagebox.de:23/./mealplanner"'} />
          </>
        ) : (
          <p className="muted" style={{ margin: "4px 0" }}>
            <code>{status.repo.display}</code>
          </p>
        )}
        {status.repo.problem && (
          <p style={{ color: "var(--accent)", margin: "4px 0", fontSize: "0.9em" }}>
            {status.repo.problem}
          </p>
        )}
      </Step>

      <Step done={!needsPassphrase} title="Choose a passphrase">
        <p className="muted" style={{ margin: "4px 0" }}>
          It encrypts the repository, and it is the only thing that can decrypt it later. Save it
          somewhere that isn&rsquo;t this box — a password manager, or paper. Nobody, including
          this app, can recover the archives without it.
        </p>
        {needsPassphrase ? (
          <>
            <p style={{ margin: "4px 0" }}>
              <button type="button" onClick={suggest}>
                Suggest one
              </button>{" "}
              <span className="muted" style={{ fontSize: "0.85em" }}>
                generated in this browser; it isn&rsquo;t sent anywhere
              </span>
            </p>
            {suggested && <Code text={`BORG_PASSPHRASE="${suggested}"`} />}
            <p className="muted" style={{ margin: "4px 0", fontSize: "0.85em" }}>
              Add it to the same <code>.env</code>, then restart the app:{" "}
              <code>docker compose up -d</code>.
            </p>
          </>
        ) : (
          <p className="muted" style={{ margin: "4px 0", fontSize: "0.85em" }}>
            Set. Don&rsquo;t change it — a new passphrase doesn&rsquo;t re-encrypt the existing
            archives, it just stops them opening.
          </p>
        )}
      </Step>

      <Step done={status.key !== null} title="Let this box in">
        {status.key ? (
          <>
            <p className="muted" style={{ margin: "4px 0" }}>
              Add this public key to the backup host — on a Hetzner Storage Box, the SSH keys
              section of its console:
            </p>
            <Code text={status.key.publicKey} />
            <p className="muted" style={{ margin: "4px 0", fontSize: "0.8em" }}>
              {status.key.fingerprint}
            </p>
          </>
        ) : (
          <>
            <p className="muted" style={{ margin: "4px 0" }}>
              The app connects with an SSH key of its own. It doesn&rsquo;t have one yet.
            </p>
            <p style={{ margin: "4px 0" }}>
              <button onClick={() => act("key")} disabled={busy !== null}>
                {busy === "key" ? "Generating…" : "Generate a key"}
              </button>
            </p>
          </>
        )}
      </Step>

      <Step done={status.lastSuccess !== null} title="Create the repository">
        <p className="muted" style={{ margin: "4px 0" }}>
          One-off. Borg refuses to initialise over a repository that already exists, so this
          can&rsquo;t overwrite anything.
        </p>
        <p style={{ margin: "4px 0" }}>
          <button onClick={() => act("init")} disabled={busy !== null || !status.configured}>
            {busy === "init" ? "Creating…" : "Create the repository"}
          </button>
        </p>
      </Step>

      <Step done={status.lastSuccess !== null} title="Take the first backup">
        <p className="muted" style={{ margin: "4px 0" }}>
          After that the app takes one every night at {status.schedule.description} — and if the box
          is off at that hour, as soon as it comes back.
        </p>
      </Step>
    </ol>
  );
}

function Step({ done, title, children }: { done: boolean; title: string; children: React.ReactNode }) {
  return (
    <li style={{ marginBottom: 12 }}>
      <span style={{ fontWeight: 600 }}>
        {done ? "✓ " : ""}
        {title}
      </span>
      {children}
    </li>
  );
}

/** A block of text meant to be copied out — a key, a setting, a command. */
function Code({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);

  return (
    <div style={{ margin: "6px 0" }}>
      <code
        style={{
          display: "block",
          padding: "8px 10px",
          border: "1px solid var(--border)",
          borderRadius: 8,
          background: "var(--bg)",
          fontSize: "0.8em",
          whiteSpace: "pre-wrap",
          wordBreak: "break-all",
        }}
      >
        {text}
      </code>
      <button
        type="button"
        style={{ marginTop: 4, fontSize: "0.8em" }}
        onClick={() => {
          navigator.clipboard
            ?.writeText(text)
            .then(() => {
              setCopied(true);
              setTimeout(() => setCopied(false), 2000);
            })
            .catch(() => {});
        }}
      >
        {copied ? "Copied" : "Copy"}
      </button>
    </div>
  );
}

/** The one sentence at the top: is this household backed up? */
function describeState(status: Status): { line: string; ok: boolean } {
  if (!status.configured) {
    return { line: "Nothing is being backed up.", ok: false };
  }
  if (!status.lastSuccess) {
    return { line: "Set up, but nothing has been backed up yet.", ok: false };
  }
  if (status.upToDate) {
    return { line: `Backed up ${formatWhen(status.lastSuccess.startedAt)}.`, ok: true };
  }

  const days = daysBetween(status.lastSuccess.day, status.dueDay);
  return {
    line:
      days <= 1
        ? `Tonight's backup hasn't run yet. The last one was ${formatWhen(status.lastSuccess.startedAt)}.`
        : `Backups are ${days} days behind — the last one was ${formatWhen(status.lastSuccess.startedAt)}.`,
    ok: days <= 1,
  };
}

function daysBetween(from: string, to: string): number {
  const ms = Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`);
  return Math.max(0, Math.round(ms / 86_400_000));
}

/** "3 hours ago" — precise enough to act on, vague enough to read. */
function formatWhen(iso: string): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "at an unknown time";

  const minutes = Math.round((Date.now() - then) / 60_000);
  if (minutes < 2) return "just now";
  if (minutes < 60) return `${minutes} minutes ago`;

  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} ${hours === 1 ? "hour" : "hours"} ago`;

  const days = Math.round(hours / 24);
  if (days === 1) return "yesterday";
  if (days < 30) return `${days} days ago`;
  return new Date(then).toLocaleDateString();
}

function formatBytes(bytes: number): string {
  const units = ["B", "kB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000;
    unit += 1;
  }
  return `${value < 10 && unit > 0 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}
