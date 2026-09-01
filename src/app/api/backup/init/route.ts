import { NextResponse } from "next/server";
import { guardOperational } from "@/lib/opsGuard";
import { recordAudit } from "@/lib/audit";
import { BorgCommandError, initRepo } from "@/lib/borg";
import { readBorgConfig } from "@/lib/borgConfig";
import { describeBorgFailure } from "@/lib/borgError";

/**
 * POST /api/backup/init — create the borg repository (§11).
 *
 * `borg init` once, at the location BORG_REPO points to. Borg refuses to
 * initialise over an existing repository, so this cannot destroy backups even
 * if it's pressed on the wrong path — the failure ("a repository already
 * exists") is reported as the reassurance it is.
 *
 * The repository is created with repokey encryption, which puts the encryption
 * key inside the repository itself. That is what makes the passphrase alone
 * enough to restore from any machine — see initArgs in borgConfig.ts.
 */
export async function POST() {
  const guard = await guardOperational();
  if (!guard.ok) return guard.response;

  const { config, missing } = readBorgConfig();
  if (missing.length > 0) {
    return NextResponse.json({
      ok: false,
      summary: `${missing.join(" and ")} ${missing.length === 1 ? "is" : "are"} unset, so there's nowhere to create a repository.`,
      hint: "Set them in the .env the app container reads, then restart it.",
    });
  }

  try {
    await initRepo(config);
    await recordAudit({
      action: "BACKUP_INITIALISED",
      actor: guard.user ? { id: guard.user.id, email: guard.user.email } : null,
      detail: `Created the backup repository at ${config.repo}.`,
    });
    return NextResponse.json({
      ok: true,
      summary: "Created the repository. Nothing is in it yet — take the first backup below.",
    });
  } catch (err) {
    if (err instanceof BorgCommandError) {
      return NextResponse.json({ ok: false, ...describeBorgFailure(err.failure, { repo: config.repo }) });
    }
    return NextResponse.json({
      ok: false,
      summary: "Couldn't create the repository.",
      detail: err instanceof Error ? err.message : String(err),
    });
  }
}
