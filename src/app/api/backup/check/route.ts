import { NextResponse } from "next/server";
import { guardOperational } from "@/lib/opsGuard";
import { checkRepository } from "@/lib/backups";

/**
 * POST /api/backup/check — reach the repository and say what's wrong (§11).
 *
 * The backup equivalent of Test connection on the mail card (§9): one round
 * trip that exercises the whole path — the key, the network, the host, the
 * passphrase and the repository — without writing anything. A failure here
 * separates "can't get there" from "got there and the backup itself broke".
 *
 * The real error is returned rather than flattened, for the same reason it is
 * there: everyone with a session is a household member on the tailnet (§10),
 * and the person reading this is the person who can go and fix the setting.
 */
export async function POST() {
  const guard = await guardOperational();
  if (!guard.ok) return guard.response;

  return NextResponse.json(await checkRepository());
}
