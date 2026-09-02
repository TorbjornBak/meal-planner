import { NextResponse } from "next/server";
import { isMailConfigured } from "@/lib/mail";
import { sendWeeklyDigest } from "@/lib/weeklyDigest";
import { mondayOf } from "@/lib/newsletter";
import { consumeAll, tooManyRequests } from "@/lib/rateLimit";
import { clientIp } from "@/lib/rateLimitPolicy";

/**
 * POST /api/newsletter/send — deliver the weekly digest (§9b).
 *
 * Sending by hand. The scheduled send is the app's own (src/instrumentation.ts),
 * so nothing external has to call this for the digest to go out; what it's for
 * is re-running a particular week, or forcing one out without waiting:
 *
 *   curl -sS -X POST -H "Authorization: Bearer $CRON_SECRET" \
 *     "https://mealplanner.example.com/api/newsletter/send?weekStart=2026-08-31"
 *
 * Authenticated with CRON_SECRET rather than a session, so it can be called
 * from a script with no cookie jar. Idempotent per member per week, so a repeat
 * is safe: it retries whoever the scheduler couldn't reach and skips the rest.
 *
 * CRON_SECRET keeps unauthenticated callers out; a generous per-address limit
 * additionally bounds a leaked secret or broken script while leaving room to
 * catch up several missed weeks by hand.
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

  const refusal = await consumeAll([["newsletter-send:ip", clientIp(req.headers)]]);
  if (refusal) return tooManyRequests(refusal);

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
