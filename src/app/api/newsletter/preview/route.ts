import { NextResponse } from "next/server";
import { currentHouseholdContext } from "@/lib/currentUser";
import { isMailConfigured } from "@/lib/mail";
import { sendWeeklyDigest } from "@/lib/weeklyDigest";
import { describeMailError } from "@/lib/mailError";

/**
 * POST /api/newsletter/preview — send myself this week's digest now (§9b).
 *
 * The honest way to check that SMTP works and that the email looks right,
 * without waiting for Friday. Forced, so it ignores both the once-per-week
 * record and the "nothing worth saying" check — and it only ever sends to the
 * person asking.
 */
export async function POST() {
  const context = await currentHouseholdContext();
  if (!context) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  if (!isMailConfigured()) {
    return NextResponse.json({ error: "mail-not-configured" }, { status: 503 });
  }

  const report = await sendWeeklyDigest({
    householdId: context.household.id,
    onlyUserId: context.user.id,
    force: true,
  });

  if (report.sent.length === 0) {
    return NextResponse.json(
      {
        error: "send-failed",
        ...describeMailError(report.lastError, process.env.SMTP_HOST),
      },
      { status: 502 },
    );
  }
  return NextResponse.json({ ok: true, to: report.sent[0] });
}
