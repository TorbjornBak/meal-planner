import { NextResponse } from "next/server";
import { guardOperational } from "@/lib/opsGuard";
import { recordAudit } from "@/lib/audit";
import { BorgCommandError, ensureSshKey } from "@/lib/borg";
import { readBorgConfig } from "@/lib/borgConfig";
import { describeBorgFailure } from "@/lib/borgError";

/**
 * POST /api/backup/key — the SSH key this instance connects with (§11).
 *
 * Generates one on first call and returns the same one after, so pressing the
 * button twice can't orphan a key the storage box has already been told to
 * trust. Only the public half ever leaves the box.
 *
 * This is most of what makes the setup short: instead of "shell into the
 * container, run ssh-keygen, find the file", a household copies one line off a
 * settings screen into their storage box.
 *
 * BACKUP_KEY_ACCESSED is worded around the Borg passphrase (§11) — the one
 * secret that actually decrypts an archive — but that value never reaches the
 * server at all: BackupCard.tsx generates the suggestion in the browser with
 * `crypto.getRandomValues` and it is typed into the .env file by hand, never
 * POSTed anywhere, precisely so it stays out of this app's logs and the
 * database it protects. The one credential-bearing event that *does* cross
 * the server boundary is this one — minting or reading the key pair this
 * instance uses to authenticate to the storage host — so that is what gets
 * recorded under the same action; the detail sentence says which secret it
 * actually was rather than borrowing the passphrase's name for something else.
 */
export async function POST() {
  const guard = await guardOperational();
  if (!guard.ok) return guard.response;

  const { config } = readBorgConfig();

  try {
    const key = await ensureSshKey(config);
    await recordAudit({
      action: "BACKUP_KEY_ACCESSED",
      actor: guard.user ? { id: guard.user.id, email: guard.user.email } : null,
      detail: key.created
        ? `Generated a new SSH key at ${key.path} for this instance to authenticate to the backup host.`
        : `Read the fingerprint of the existing SSH key at ${key.path} that this instance authenticates to the backup host with.`,
    });
    return NextResponse.json({
      ok: true,
      created: key.created,
      publicKey: key.publicKey,
      fingerprint: key.fingerprint,
      path: key.path,
      summary: key.created
        ? "Generated a new SSH key. Add the public key below to your backup host."
        : "This instance already has a key. Add the public key below to your backup host.",
    });
  } catch (err) {
    if (err instanceof BorgCommandError) {
      return NextResponse.json({ ok: false, ...describeBorgFailure(err.failure) });
    }
    return NextResponse.json({
      ok: false,
      summary: "Couldn't create the SSH key.",
      hint: `The app needs to be able to write to ${config.sshKeyPath}. In Docker that means a volume mounted there and owned by the app's user.`,
      detail: err instanceof Error ? err.message : String(err),
    });
  }
}
