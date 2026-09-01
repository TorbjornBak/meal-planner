import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { RESET_TTL_MS, issueAuthToken, normalizeEmail, recordThrottleOnce } from "@/lib/auth";
import { isMailConfigured, sendMail } from "@/lib/mail";
import { passwordResetEmail } from "@/lib/emails";
import { recordAudit } from "@/lib/audit";
import { consumeAll, tooManyRequests } from "@/lib/rateLimit";
import { clientIp } from "@/lib/rateLimitPolicy";

const Input = z.object({ email: z.string().min(1).max(320) });

/**
 * POST /api/password/forgot — email a reset link (§9).
 *
 * Answers `{ ok: true }` whether or not the address has an account. The reply
 * is the same either way on purpose: this endpoint is unauthenticated, and a
 * different answer for a known address turns it into a way to test which of
 * the household's addresses are registered.
 */
export async function POST(req: Request) {
  const parsed = Input.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid" }, { status: 400 });
  }

  const email = normalizeEmail(parsed.data.email);
  const ip = clientIp(req.headers);

  // Consumed before the mail-configured check and the lookup below, and for
  // every address alike, so a 429 here says nothing about whether `email` has
  // an account — only that this address, or this IP, has asked too often.
  const refusal = await consumeAll([
    ["password-forgot:ip", ip],
    ["password-forgot:email", email],
  ]);
  if (refusal) {
    await recordThrottleOnce({
      bucket: refusal.bucket,
      subject: refusal.bucket === "password-forgot:email" ? email : ip,
    });
    return tooManyRequests(refusal);
  }

  // The one thing worth being honest about: an instance with no SMTP will
  // never deliver anything, and silence there is a support call, not a leak.
  if (!isMailConfigured()) {
    return NextResponse.json({ error: "mail-not-configured" }, { status: 503 });
  }

  const user = await prisma.user.findUnique({ where: { email } });

  if (user) {
    const token = await issueAuthToken(user.id, "PASSWORD_RESET", RESET_TTL_MS);
    const mail = passwordResetEmail({ name: user.name, token });
    try {
      await sendMail({ to: user.email, ...mail });
    } catch (err) {
      // Log for the operator; still answer ok, so a failing relay doesn't
      // become an account-existence oracle.
      console.error("password reset mail failed", err);
    }
    // Recorded only when there's a real account to name. A burst of these
    // against one address is the thing worth an admin noticing; the write
    // itself is invisible to whoever sent the request, so it adds nothing to
    // what the response already withholds.
    await recordAudit({
      action: "PASSWORD_RESET_REQUESTED",
      subjectEmail: user.email,
      detail: `A password reset was requested for ${user.email}.`,
    });
  }

  return NextResponse.json({ ok: true });
}
