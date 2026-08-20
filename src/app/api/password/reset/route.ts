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

const Input = z.object({
  token: z.string().min(1).max(200),
  password: z.string().min(1).max(200),
  /** Invitations and resets are the same mechanism with different copy. */
  purpose: z.enum(["PASSWORD_RESET", "INVITE"]).default("PASSWORD_RESET"),
});

/**
 * POST /api/password/reset — spend a link token and set a new password (§9).
 *
 * On success the caller is signed in immediately: they've just proved control
 * of the mailbox and chosen a password, so sending them back to a login form
 * would ask them to type it again for nothing.
 */
export async function POST(req: Request) {
  const parsed = Input.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid" }, { status: 400 });
  }

  const problem = passwordProblem(parsed.data.password);
  if (problem) {
    return NextResponse.json({ error: "weak-password", message: problem }, { status: 400 });
  }

  // Validate the password *before* spending the token, so a rejected password
  // doesn't burn the link and force another trip through the inbox.
  const user = await redeemAuthToken(parsed.data.token, parsed.data.purpose);
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

  if (parsed.data.purpose === "PASSWORD_RESET" && isMailConfigured()) {
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
