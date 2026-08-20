import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import {
  SESSION_COOKIE,
  SESSION_MAX_AGE_SECONDS,
  createSession,
  looksLikeEmail,
  needsSetup,
  normalizeEmail,
  sessionCookieOptions,
} from "@/lib/auth";
import { hashPassword, passwordProblem } from "@/lib/password";

const Input = z.object({
  email: z.string().min(1).max(320),
  name: z.string().max(120).optional(),
  password: z.string().min(1).max(200),
});

/**
 * POST /api/setup — create the very first account (§9).
 *
 * Open to anyone, but only while the instance has no accounts at all. The
 * moment one exists this route is closed for good and further members arrive
 * by invitation. On a home box behind Tailscale (§10) the window is only
 * reachable from the tailnet anyway.
 */
export async function POST(req: Request) {
  if (!(await needsSetup())) {
    return NextResponse.json({ error: "already-set-up" }, { status: 409 });
  }

  const parsed = Input.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid" }, { status: 400 });
  }

  const email = normalizeEmail(parsed.data.email);
  if (!looksLikeEmail(email)) {
    return NextResponse.json({ error: "invalid-email" }, { status: 400 });
  }

  const problem = passwordProblem(parsed.data.password);
  if (problem) {
    return NextResponse.json({ error: "weak-password", message: problem }, { status: 400 });
  }

  let user;
  try {
    user = await prisma.user.create({
      data: {
        email,
        name: parsed.data.name?.trim() || null,
        passwordHash: await hashPassword(parsed.data.password),
        lastLoginAt: new Date(),
      },
    });
  } catch {
    // Two people hitting /setup at once: the unique index on email decides.
    return NextResponse.json({ error: "already-set-up" }, { status: 409 });
  }

  const token = await createSession(user.id);
  const res = NextResponse.json({ ok: true });
  res.cookies.set(SESSION_COOKIE, token, sessionCookieOptions(SESSION_MAX_AGE_SECONDS));
  return res;
}

// GET /api/setup — whether the first-run form should still be offered.
export async function GET() {
  return NextResponse.json({ needsSetup: await needsSetup() });
}
