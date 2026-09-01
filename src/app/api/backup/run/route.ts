import { NextResponse } from "next/server";
import { bearerTokenMatches } from "@/lib/auth";
import { guardOperational } from "@/lib/opsGuard";
import { recordAudit } from "@/lib/audit";
import { serializeRun, takeBackup } from "@/lib/backups";

/**
 * POST /api/backup/run — take a backup now (§11).
 *
 * The nightly backup is the app's own (src/instrumentation.ts), so nothing
 * external has to call this for a household to be backed up. What it's for is
 * the button on the settings screen — the first backup, or one before a risky
 * upgrade — and, for anyone who'd rather drive it from the host, a script:
 *
 *   curl -sS -X POST -H "Authorization: Bearer $CRON_SECRET" \
 *     https://box.example.ts.net/api/backup/run
 *
 * A session or CRON_SECRET will do, the second so it works with no cookie jar.
 *
 * Safe to call repeatedly: a backup already running is joined rather than
 * duplicated, and an extra archive costs almost nothing on a deduplicated
 * repository anyway.
 *
 * Answers 200 with `ok: false` and a diagnosis when the backup fails, rather
 * than an error status — the failure *is* the response, and the screen renders
 * it the same way the mail card renders an SMTP error (§9).
 */
export async function POST(req: Request) {
  // Either a platform admin pressing the button, or a host script presenting
  // CRON_SECRET. What is no longer enough is merely being signed in.
  const bearer = bearerTokenMatches(
    req.headers.get("authorization"),
    process.env.CRON_SECRET,
  );
  const guard = await guardOperational({ bearer });
  if (!guard.ok) return guard.response;

  const outcome = await takeBackup({ trigger: "MANUAL" });

  // borg's own summaries already end in a full stop, so the outcome is
  // appended as its own sentence rather than glued on with another one.
  const outcomeSentence = outcome.ok ? "It succeeded." : outcome.summary;
  await recordAudit({
    action: "BACKUP_RUN_REQUESTED",
    actor: guard.user ? { id: guard.user.id, email: guard.user.email } : null,
    detail: `${guard.user ? "Ran a backup by hand" : "Ran a backup from a script"}. ${outcomeSentence}`,
  });

  return NextResponse.json({
    ok: outcome.ok,
    summary: outcome.summary,
    hint: outcome.hint,
    detail: outcome.detail,
    skipped: outcome.skipped,
    run: outcome.run ? serializeRun(outcome.run) : null,
  });
}
