import { NextResponse } from "next/server";
import { guardOperational } from "@/lib/opsGuard";
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
 */
export async function POST() {
  const guard = await guardOperational();
  if (!guard.ok) return guard.response;

  const { config } = readBorgConfig();

  try {
    const key = await ensureSshKey(config);
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
