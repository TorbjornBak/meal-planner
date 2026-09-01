import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import {
  SESSION_COOKIE,
  SESSION_MAX_AGE_SECONDS,
  createSession,
  destroyAllSessions,
  redeemAuthToken,
  sessionCookieOptions,
} from "@/lib/auth";
import { hashPassword, passwordProblem } from "@/lib/password";
import { isMailConfigured, sendMail } from "@/lib/mail";
import { passwordChangedEmail } from "@/lib/emails";
import { recordAudit } from "@/lib/audit";
import { consumeAll, recordThrottleOnce, tooManyRequests } from "@/lib/rateLimit";
import { clientIp } from "@/lib/rateLimitPolicy";

const Input = z.object({
  token: z.string().min(1).max(200),
  password: z.string().min(1).max(200),
});

/**
 * POST /api/password/reset — spend a link token and set a new password (§9).
 *
 * On success the caller is signed in immediately: they've just proved control
 * of the mailbox and chosen a password, so sending them back to a login form
 * would ask them to type it again for nothing.
 *
 * Redeems only PASSWORD_RESET tokens. Before Phase 4's Invitation model, this
 * endpoint also took a `purpose` field and would redeem an INVITE AuthToken —
 * which meant any caller holding one, or simply guessing the string, could ask
 * this route to treat it as one. Invitations are minted and spent as
 * Invitation rows now, through /api/invitations/accept, so there is nothing
 * left for this endpoint to redeem but a reset link, and it no longer takes
 * the caller's word for which kind of token it's holding (Phase 6).
 */
export async function POST(req: Request) {
  const parsed = Input.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid" }, { status: 400 });
  }

  const ip = clientIp(req.headers);

  // Keyed by address only — the token is 256 bits, so this isn't about
  // guessing it, it's about not letting a scripted caller hammer the endpoint
  // that writes password hashes.
  const refusal = await consumeAll([["password-reset:ip", ip]]);
  if (refusal) {
    await recordThrottleOnce({ bucket: refusal.bucket, subject: ip });
    return tooManyRequests(refusal);
  }

  const problem = passwordProblem(parsed.data.password);
  if (problem) {
    return NextResponse.json({ error: "weak-password", message: problem }, { status: 400 });
  }

  // Validate the password *before* spending the token, so a rejected password
  // doesn't burn the link and force another trip through the inbox.
  const user = await redeemAuthToken(parsed.data.token, "PASSWORD_RESET");
  if (!user) {
    return NextResponse.json({ error: "invalid-token" }, { status: 400 });
  }

  await prisma.user.update({
    where: { id: user.id },
    data: { passwordHash: await hashPassword(parsed.data.password), lastLoginAt: new Date() },
  });

  // A reset is the remedy for a stolen session as much as a forgotten
  // password, so every existing session dies here.
  await destroyAllSessions(user.id);

  await recordAudit({
    action: "PASSWORD_RESET_COMPLETED",
    subjectEmail: user.email,
    detail: `${user.email} completed a password reset.`,
  });

  if (isMailConfigured()) {
    try {
      await sendMail({ to: user.email, ...passwordChangedEmail({ name: user.name }) });
    } catch (err) {
      console.error("password change notice failed", err);
    }
  }

  const token = await createSession(user.id);
  const res = NextResponse.json({ ok: true });
  res.cookies.set(SESSION_COOKIE, token, sessionCookieOptions(SESSION_MAX_AGE_SECONDS));
  return res;
}
