import { NextResponse } from "next/server";
import { guardOperational } from "@/lib/opsGuard";
import { recentAudit } from "@/lib/audit";

/**
 * GET /api/admin/audit — what platform admins have been doing (§9c).
 *
 * Readable by platform admins, which is the same set of people who write it.
 * That is weaker than an audit trail shipped off the box, and it is the right
 * amount for an installation whose operators are one or two people who know
 * each other: the point here is that an intervention cannot happen *silently*,
 * not that it is unforgeable by somebody with the database password.
 */
export async function GET() {
  const guard = await guardOperational();
  if (!guard.ok) return guard.response;

  return NextResponse.json(await recentAudit());
}
