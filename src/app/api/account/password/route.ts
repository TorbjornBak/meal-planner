import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { currentUser } from "@/lib/currentUser";
import {
  SESSION_COOKIE,
  SESSION_MAX_AGE_SECONDS,
  createSession,
  destroyAllSessions,
  sessionCookieOptions,
} from "@/lib/auth";
import { hashPassword, passwordProblem, verifyPassword } from "@/lib/password";
import { isMailConfigured, sendMail } from "@/lib/mail";
import { passwordChangedEmail } from "@/lib/emails";
import { recordAudit } from "@/lib/audit";
import { consumeAll, tooManyRequests } from "@/lib/rateLimit";

const Input = z.object({
  currentPassword: z.string().min(1).max(200),
  newPassword: z.string().min(1).max(200),
});

/**
 * POST /api/account/password — change my own password while signed in (§9).
 *
 * Requires the current password even though there's already a session: it's
 * what stops a borrowed unlocked phone from locking its owner out.
 */
export async function POST(req: Request) {
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  // Before verifying, not after: the thing this limit exists to stop is a
  // stolen session being used to grind the current password out of this very
  // field, and a count that only started once a guess had already failed
  // would let the first nine guesses of every ten go free.
  const refusal = await consumeAll([["password-change:user", user.id]]);
  if (refusal) return tooManyRequests(refusal);

  const parsed = Input.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid" }, { status: 400 });
  }

  if (!(await verifyPassword(parsed.data.currentPassword, user.passwordHash))) {
    return NextResponse.json({ error: "wrong-password" }, { status: 401 });
  }

  const problem = passwordProblem(parsed.data.newPassword);
  if (problem) {
    return NextResponse.json({ error: "weak-password", message: problem }, { status: 400 });
  }

  await prisma.user.update({
    where: { id: user.id },
    data: { passwordHash: await hashPassword(parsed.data.newPassword) },
  });

  // Drop every session, then immediately open a fresh one for the browser
  // doing the changing — other devices are signed out, this one isn't.
  await destroyAllSessions(user.id);
  const token = await createSession(user.id);

  // What an account takeover looks like from the outside starts here: the row
  // says the change happened and that every other session was closed by it,
  // which is the fact worth checking first if this address later reports
  // being locked out.
  await recordAudit({
    action: "PASSWORD_CHANGED",
    actor: { id: user.id, email: user.email },
    detail: `${user.email} changed their password, which signed out every other device.`,
  });

  if (isMailConfigured()) {
    try {
      await sendMail({ to: user.email, ...passwordChangedEmail({ name: user.name }) });
    } catch (err) {
      console.error("password change notice failed", err);
    }
  }

  const jar = await cookies();
  jar.set(SESSION_COOKIE, token, sessionCookieOptions(SESSION_MAX_AGE_SECONDS));

  return NextResponse.json({ ok: true });
}
