import { NextResponse } from "next/server";
import { isMailConfigured } from "@/lib/mail";
import { sendWeeklyDigest } from "@/lib/weeklyDigest";
import { mondayOf } from "@/lib/newsletter";

/**
 * POST /api/newsletter/send — deliver the weekly digest (§9b).
 *
 * Triggered by cron on the host rather than by a scheduler inside the app.
 * DESIGN.md rules out background jobs, and this keeps that true: the app has
 * no timer, it just exposes an endpoint that something else calls.
 *
 *   0 17 * * FRI curl -fsS -X POST \
 *     -H "Authorization: Bearer $CRON_SECRET" \
 *     https://box.example.ts.net/api/newsletter/send
 *
 * Authenticated with CRON_SECRET, not a session — cron has no cookie jar. The
 * route is idempotent per member per week, so a retry is safe.
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
