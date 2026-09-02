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
import { acceptInvitation, inspectInvitation } from "@/lib/invitationService";
import { consumeAll, recordThrottleOnce, tooManyRequests } from "@/lib/rateLimit";
import { clientIp } from "@/lib/rateLimitPolicy";
import { verifyTurnstile } from "@/lib/turnstile";
import { TURNSTILE_ACTIONS } from "@/lib/turnstileActions";

/**
 * POST /api/invitations/accept — spend an invitation (§9).
 *
 * Public, because the ordinary case is a person answering who has no account
 * yet: for them, the link itself stands in for a session — single use, seven
 * days, and bound to one mailbox. That is *not* extended to an address that
 * already has an account: acceptInvitation refuses those with
 * `sign-in-required` unless the caller already holds a session for that
 * exact address, because otherwise the link alone would be a bearer
 * credential for signing in as somebody else with no password at all.
 *
 * On success the caller is signed in and the browser's active household is the
 * one they just joined. They proved control of the address — by opening the
 * link when no account existed yet, or by already being signed in as it when
 * one did — and (when there was one to choose) chose a password; bouncing
 * them to a login form to type it again would be ceremony.
 */

const Input = z.object({
  token: z.string().min(1).max(200),
  /** Only when the address has no account yet; ignored when it has one. */
  password: z.string().min(1).max(200).optional(),
  name: z.string().max(120).optional(),
  /** Only for a platform invitation, which creates the household. */
  householdName: z.string().max(120).optional(),
  "cf-turnstile-response": z.unknown().optional(),
});

/** The refusals that are the visitor's link being wrong, not their input. */
const LINK_PROBLEMS = new Set(["invalid-token", "expired", "revoked", "accepted"]);

export async function POST(req: Request) {
  const parsed = Input.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "invalid" }, { status: 400 });

  if (
    !(await verifyTurnstile(
      req,
      parsed.data["cf-turnstile-response"],
      TURNSTILE_ACTIONS.invitationAccept,
    ))
  ) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const ip = clientIp(req.headers);

  // A read-only peek at the invitation, purely to learn the address it's
  // bound to for the second rate-limit key below — never to decide anything
  // about the acceptance itself, which acceptInvitation still re-checks for
  // real further down. A token that doesn't resolve to a live invitation
  // simply has no email to key on, the same way an unattributable caller has
  // no IP: the key is skipped rather than folded into a shared bucket.
  const invitation = await inspectInvitation(parsed.data.token);

  const refusal = await consumeAll([
    ["invitation:accept:ip", ip],
    ["invitation:accept:email", invitation?.email ?? null],
  ]);
  if (refusal) {
    await recordThrottleOnce({
      bucket: refusal.bucket,
      subject: refusal.bucket === "invitation:accept:email" ? (invitation?.email ?? null) : ip,
    });
    return tooManyRequests(refusal);
  }

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

  // INVITATION_ACCEPTED and HOUSEHOLD_MEMBER_JOINED are recorded inside
  // acceptInvitation itself, not here: that function already has the
  // invitation's own household name and whether it just created that
  // household in scope, from the same transaction that spent the token, which
  // is a truer "at the point of the act" than a second lookup from this route
  // could reconstruct.
  const token = await createSession(result.userId, result.householdId);
  const res = NextResponse.json({
    ok: true,
    plan: result.plan,
    householdId: result.householdId,
  });
  res.cookies.set(SESSION_COOKIE, token, sessionCookieOptions(SESSION_MAX_AGE_SECONDS));
  return res;
}
