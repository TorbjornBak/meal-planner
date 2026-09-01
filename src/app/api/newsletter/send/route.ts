import { NextResponse } from "next/server";
import { isMailConfigured } from "@/lib/mail";
import { sendWeeklyDigest } from "@/lib/weeklyDigest";
import { mondayOf } from "@/lib/newsletter";

/**
 * POST /api/newsletter/send — deliver the weekly digest (§9b).
 *
 * Sending by hand. The scheduled send is the app's own (src/instrumentation.ts),
 * so nothing external has to call this for the digest to go out; what it's for
 * is re-running a particular week, or forcing one out without waiting:
 *
 *   curl -sS -X POST -H "Authorization: Bearer $CRON_SECRET" \
 *     "https://box.example.ts.net/api/newsletter/send?weekStart=2026-08-31"
 *
 * Authenticated with CRON_SECRET rather than a session, so it can be called
 * from a script with no cookie jar. Idempotent per member per week, so a repeat
 * is safe: it retries whoever the scheduler couldn't reach and skips the rest.
 *
 * Deliberately not rate-limited (Phase 6). The endpoints that are — invitation
 * issuing, the SMTP test button, a password change — are all reachable by
 * somebody who only holds a session or a guessed address, so the limit is
 * doing real work against a guessing run or a careless click. This one is
 * gated by CRON_SECRET, a 256-bit-class value nobody is guessing, and its own
 * idempotency already caps the damage a repeat can do: a retried tick sends
 * nothing to a member who was already delivered to this week. What a counting
 * window would add is a way to fail the one case this route exists for —
 * catching up several missed weeks by hand, one `?weekStart=` at a time, while
 * fixing a relay that was down — by refusing the fourth or fifth of them.
 * There is no `newsletter-send` bucket in rateLimitPolicy.ts for exactly this
 * reason; this is that decision written down, not an oversight.
 */
export async function POST(req: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    return NextResponse.json({ error: "cron-secret-not-set" }, { status: 503 });
  }

  const auth = req.headers.get("authorization") ?? "";
  const presented = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!timingSafeEqual(presented, secret)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  if (!isMailConfigured()) {
    return NextResponse.json({ error: "mail-not-configured" }, { status: 503 });
  }

  // ?weekStart=YYYY-MM-DD to re-run a specific week by hand; otherwise the
  // coming Monday, which is what a Friday-evening cron wants.
  const raw = new URL(req.url).searchParams.get("weekStart");
  const weekStart = raw ? mondayOf(new Date(`${raw}T00:00:00Z`)) : undefined;
  if (raw && (!weekStart || Number.isNaN(weekStart.getTime()))) {
    return NextResponse.json({ error: "invalid-week" }, { status: 400 });
  }

  const report = await sendWeeklyDigest({ weekStart });
  return NextResponse.json(report);
}

/** Constant-time compare, so the secret can't be recovered a byte at a time. */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
