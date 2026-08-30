import { NextResponse } from "next/server";
import { currentUser } from "@/lib/currentUser";
import { backupStatus } from "@/lib/backups";

/**
 * GET /api/backup — the state of the household's backups (§11).
 *
 * Answers one question in a form a settings screen can render: is this
 * household backed up, and if not, what's stopping it. Everything here is read
 * locally — the runs table, the key file, which tools are installed — with no
 * round trip to the storage box, because this loads on every visit to the
 * settings page and a page that hangs while an unreachable host times out
 * would be a worse way to learn that than the line it shows instead.
 *
 * Reaching the repository is POST /api/backup/check, which is a button.
 */
export async function GET() {
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  return NextResponse.json(await backupStatus());
}
