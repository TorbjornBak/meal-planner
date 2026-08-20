import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import {
  SESSION_COOKIE,
  SESSION_MAX_AGE_SECONDS,
  createSession,
  normalizeEmail,
  sessionCookieOptions,
} from "@/lib/auth";
import { dummyHash, verifyPassword } from "@/lib/password";

const Input = z.object({
  email: z.string().min(1).max(320),
  password: z.string().min(1).max(200),
});

// POST /api/login — exchange an email and password for a session cookie (§9).
export async function POST(req: Request) {
  const parsed = Input.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid" }, { status: 400 });
  }

  const email = normalizeEmail(parsed.data.email);
  const user = await prisma.user.findUnique({ where: { email } });

  // Always pay the full scrypt cost — against a throwaway hash when there's no
  // such account, or none set yet — so response time doesn't quietly answer
  // "does this address have an account here?".
  const ok = await verifyPassword(
    parsed.data.password,
    user?.passwordHash ?? (await dummyHash()),
  );

  if (!user || !ok) {
    return NextResponse.json({ error: "invalid" }, { status: 401 });
  }

  const token = await createSession(user.id);
  await prisma.user.update({
    where: { id: user.id },
    data: { lastLoginAt: new Date() },
  });

  const res = NextResponse.json({ ok: true });
  res.cookies.set(SESSION_COOKIE, token, sessionCookieOptions(SESSION_MAX_AGE_SECONDS));
  return res;
}
