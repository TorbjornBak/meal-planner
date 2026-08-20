import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { RESET_TTL_MS, issueAuthToken, normalizeEmail } from "@/lib/auth";
import { isMailConfigured, sendMail } from "@/lib/mail";
import { passwordResetEmail } from "@/lib/emails";

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

  // The one thing worth being honest about: an instance with no SMTP will
  // never deliver anything, and silence there is a support call, not a leak.
  if (!isMailConfigured()) {
    return NextResponse.json({ error: "mail-not-configured" }, { status: 503 });
  }

  const user = await prisma.user.findUnique({
    where: { email: normalizeEmail(parsed.data.email) },
  });

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
  }

  return NextResponse.json({ ok: true });
}
