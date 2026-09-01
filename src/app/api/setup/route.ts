import { NextResponse } from "next/server";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import {
  SESSION_COOKIE,
  SESSION_MAX_AGE_SECONDS,
  createSession,
  looksLikeEmail,
  needsSetup,
  normalizeEmail,
  recordThrottleOnce,
  sessionCookieOptions,
} from "@/lib/auth";
import { hashPassword, passwordProblem } from "@/lib/password";
import { consumeAll, tooManyRequests } from "@/lib/rateLimit";
import { clientIp } from "@/lib/rateLimitPolicy";

const Input = z.object({
  email: z.string().min(1).max(320),
  name: z.string().max(120).optional(),
  password: z.string().min(1).max(200),
});

// The expand/backfill migration creates this household for both upgraded and
// fresh databases. A later invitation flow will ask new owners for a name.
const INITIAL_HOUSEHOLD_ID = "initial-household";

class AlreadySetUpError extends Error {
  constructor() {
    super("already-set-up");
    this.name = "AlreadySetUpError";
  }
}

function isSetupRace(error: unknown): boolean {
  if (error instanceof AlreadySetUpError) return true;
  if (!(error instanceof Prisma.PrismaClientKnownRequestError)) return false;

  // P2002: another setup transaction created the email first.
  // P2034: PostgreSQL's serializable isolation aborted one concurrent winner.
  return error.code === "P2002" || error.code === "P2034";
}

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

  // Only after the instance is already closed does this stop mattering; while
  // it's open, this is the one window in the whole app an anonymous caller can
  // use to create an account, so it gets the same treatment as login.
  const ip = clientIp(req.headers);
  const refusal = await consumeAll([["setup:ip", ip]]);
  if (refusal) {
    await recordThrottleOnce({ bucket: refusal.bucket, subject: ip });
    return tooManyRequests(refusal);
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

  const passwordHash = await hashPassword(parsed.data.password);
  let user;
  try {
    user = await prisma.$transaction(
      async (tx) => {
        // The public first-run route must still have exactly one winner when
        // two different email addresses submit concurrently.
        if ((await tx.user.count()) > 0) throw new AlreadySetUpError();

        const household = await tx.household.upsert({
          where: { id: INITIAL_HOUSEHOLD_ID },
          update: {},
          create: { id: INITIAL_HOUSEHOLD_ID, name: "Primary household" },
        });

        return tx.user.create({
          data: {
            email,
            name: parsed.data.name?.trim() || null,
            passwordHash,
            lastLoginAt: new Date(),
            platformRole: "ADMIN",
            memberships: {
              create: { householdId: household.id, role: "ADMIN" },
            },
          },
        });
      },
      { isolationLevel: "Serializable" },
    );
  } catch (error) {
    // The serializable transaction makes concurrent first-run submissions
    // race on the empty-user predicate, including when the emails differ.
    if (isSetupRace(error)) {
      return NextResponse.json({ error: "already-set-up" }, { status: 409 });
    }

    console.error("initial setup failed", error);
    return NextResponse.json({ error: "setup-failed" }, { status: 500 });
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
