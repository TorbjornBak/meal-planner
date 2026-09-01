import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import {
  SESSION_COOKIE,
  SESSION_MAX_AGE_SECONDS,
  createSession,
  normalizeEmail,
  recordThrottleOnce,
  sessionCookieOptions,
} from "@/lib/auth";
import { dummyHash, verifyPassword } from "@/lib/password";
import { consumeAll, tooManyRequests } from "@/lib/rateLimit";
import { clientIp } from "@/lib/rateLimitPolicy";

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
  const ip = clientIp(req.headers);

  // Consumed for every request alike, whether or not `email` turns out to
  // belong to an account — exactly like the dummyHash() below. A limiter that
  // only counted attempts against real accounts would itself become the
  // oracle §9 is careful to avoid on the response that follows it.
  const refusal = await consumeAll([
    ["login:ip", ip],
    ["login:email", email],
  ]);
  if (refusal) {
    await recordThrottleOnce({
      bucket: refusal.bucket,
      subject: refusal.bucket === "login:email" ? email : ip,
    });
    return tooManyRequests(refusal);
  }

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
