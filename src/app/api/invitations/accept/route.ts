import { NextResponse } from "next/server";
import { z } from "zod";
import {
  SESSION_COOKIE,
  SESSION_MAX_AGE_SECONDS,
  createSession,
  sessionCookieOptions,
} from "@/lib/auth";
import { currentUser } from "@/lib/currentUser";
import { hashPassword, passwordProblem } from "@/lib/password";
import { acceptInvitation } from "@/lib/invitationService";

/**
 * POST /api/invitations/accept — spend an invitation (§9).
 *
 * Public, because the whole point is that the person answering has no account
 * yet. What stands in for a session is the link itself: single use, seven days,
 * and bound to one mailbox.
 *
 * On success the caller is signed in and the browser's active household is the
 * one they just joined. They proved control of the address and (when there was
 * one to choose) chose a password; bouncing them to a login form to type it
 * again would be ceremony.
 */

const Input = z.object({
  token: z.string().min(1).max(200),
  /** Only when the address has no account yet; ignored when it has one. */
  password: z.string().min(1).max(200).optional(),
  name: z.string().max(120).optional(),
  /** Only for a platform invitation, which creates the household. */
  householdName: z.string().max(120).optional(),
});

/** The refusals that are the visitor's link being wrong, not their input. */
const LINK_PROBLEMS = new Set(["invalid-token", "expired", "revoked", "accepted"]);

export async function POST(req: Request) {
  const parsed = Input.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "invalid" }, { status: 400 });

  // Hashed before the transaction: scrypt is deliberately slow, and holding a
  // database transaction open for it would serialise every other write behind
  // one person choosing a password.
  let passwordHash: string | undefined;
  if (parsed.data.password) {
    const problem = passwordProblem(parsed.data.password);
    if (problem) {
      return NextResponse.json({ error: "weak-password", message: problem }, { status: 400 });
    }
    passwordHash = await hashPassword(parsed.data.password);
  }

  // A visitor who is already signed in takes part in the email binding: an
  // invitation for another address must not quietly join their account to a
  // household it was never offered to.
  const signedIn = await currentUser();

  const result = await acceptInvitation({
    token: parsed.data.token,
    signedInEmail: signedIn?.email ?? null,
    passwordHash,
    name: parsed.data.name,
    householdName: parsed.data.householdName,
  });

  if (!result.ok) {
    const status = LINK_PROBLEMS.has(result.error) ? 410 : 400;
    return NextResponse.json({ error: result.error }, { status });
  }

  const token = await createSession(result.userId, result.householdId);
  const res = NextResponse.json({
    ok: true,
    plan: result.plan,
    householdId: result.householdId,
  });
  res.cookies.set(SESSION_COOKIE, token, sessionCookieOptions(SESSION_MAX_AGE_SECONDS));
  return res;
}
