import { headers } from "next/headers";
import Link from "next/link";
import { currentUser } from "@/lib/currentUser";
import { invitationPath, planRequiresSignIn } from "@/lib/invitations";
import { inspectInvitation } from "@/lib/invitationService";
import { MIN_PASSWORD_LENGTH } from "@/lib/password";
import { recordThrottleOnce } from "@/lib/rateLimit";
import { consumeAll } from "@/lib/rateLimit";
import { clientIp } from "@/lib/rateLimitPolicy";
import { AcceptForm } from "./AcceptForm";

/**
 * Land here from an emailed invitation (§9).
 *
 * `inspectInvitation` is read-only — it looks the token up without spending
 * it — so a dead-end link says so before anyone has typed anything, and
 * refreshing this page after a first, successful submission on another tab
 * shows "already accepted" rather than erroring on a token that no longer
 * exists to redeem. Whether it can still be redeemed is decided again, for
 * real, when the form posts to /api/invitations/accept; this page's only job
 * is choosing the right words in advance.
 *
 * This is the one rate-limited endpoint in Phase 6's slice that isn't a route
 * handler, so it reads the caller's address with `next/headers` instead of
 * from a Request, and counts it against `invitation:inspect:ip` before
 * looking anything up.
 */
export default async function InvitePage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;

  const ip = clientIp(await headers());
  const refusal = await consumeAll([["invitation:inspect:ip", ip]]);
  if (refusal) {
    await recordThrottleOnce({ bucket: refusal.bucket, subject: ip });
    return <Throttled retryAfterSeconds={refusal.retryAfterSeconds} />;
  }

  const invitation = await inspectInvitation(token);

  if (!invitation) return <DeadEnd state="invalid" />;
  if (invitation.state !== "live") return <DeadEnd state={invitation.state} />;

  // link-account and already-a-member both spend an account that already
  // exists, and acceptInvitation now refuses to mint a session for one of
  // those from an anonymous request — the fix for the takeover this page
  // used to make possible (a mailed or forwarded link was, by itself, enough
  // to sign in as whoever it was addressed to). A visitor with no session at
  // all is told that plainly, before they fill anything in, rather than
  // discovering it only after submitting a form that was never going to
  // succeed. A visitor signed in as some *other* address still reaches
  // AcceptForm below, which already has its own dead end for that case.
  if (planRequiresSignIn(invitation.plan) && !(await currentUser())) {
    return <SignInRequired email={invitation.email} token={token} />;
  }

  return (
    <AcceptForm
      token={token}
      email={invitation.email}
      invitedName={invitation.invitedName}
      kind={invitation.kind}
      householdName={invitation.householdName}
      invitedBy={invitation.invitedBy}
      plan={invitation.plan}
      askForPassword={invitation.askForPassword}
      askForHouseholdName={invitation.askForHouseholdName}
      minLength={MIN_PASSWORD_LENGTH}
    />
  );
}

/**
 * What a caller sees after opening too many invitation links too quickly
 * (§9, Phase 6).
 *
 * A Server Component page has no response object to hang a real 429 status
 * and a Retry-After header on — that machinery is what Route Handlers are
 * for, and /api/invitations/accept carries it. This is the same worded
 * refusal the states below already use at a plain 200; the wait is still the
 * useful fact, so it's said in the copy rather than a header nothing here
 * could set.
 */
function Throttled({ retryAfterSeconds }: { retryAfterSeconds: number }) {
  const minutes = Math.max(1, Math.ceil(retryAfterSeconds / 60));
  return (
    <div className="card" style={{ maxWidth: 380, margin: "3rem auto" }}>
      <h1>Too many attempts</h1>
      <p style={{ color: "var(--muted)" }}>
        This address has opened a lot of invitation links in a short time. Wait about {minutes}{" "}
        minute{minutes === 1 ? "" : "s"} and try this link again.
      </p>
    </div>
  );
}

/**
 * What a visitor with no session sees when the invitation is for an address
 * that already has an account (§9).
 *
 * `next` sends them back to this exact invite URL once they've signed in —
 * the login page already supports that (src/app/login/page.tsx) and only
 * ever follows a relative path, so there is no new open-redirect surface to
 * introduce here. After that round trip inspectInvitation and currentUser
 * both see the same session, this function's own check passes, and the
 * ordinary AcceptForm appears — no separate "resume acceptance" flow to
 * build or keep in sync with the real one.
 */
function SignInRequired({ email, token }: { email: string; token: string }) {
  return (
    <div className="card" style={{ maxWidth: 380, margin: "3rem auto" }}>
      <h1>Sign in to accept this invitation</h1>
      <p style={{ color: "var(--muted)" }}>
        <strong>{email}</strong> already has a MealPlanner account. Sign in with that address and
        you&apos;ll land back here to finish joining — nothing about your password changes.
      </p>
      <p style={{ marginTop: 16 }}>
        <Link href={`/login?next=${encodeURIComponent(invitationPath(token))}`}>Sign in</Link>
      </p>
    </div>
  );
}

/**
 * What a spent, withdrawn, expired or simply unrecognised link says.
 *
 * The four states get four different sentences rather than one "invalid
 * link" for all of them, because the right next step differs: an expired or
 * revoked link means ask the household again, while an already-accepted one
 * almost always means the reader already finished this days ago and is
 * opening a stray copy from their inbox — the useful thing to offer there is
 * signing in, not a dead end.
 */
function DeadEnd({ state }: { state: "invalid" | "revoked" | "accepted" | "expired" }) {
  const copy: Record<typeof state, { title: string; body: string }> = {
    invalid: {
      title: "That invitation doesn't exist",
      body: "This link doesn't match anything we know about — it may have been mistyped, or copied incompletely from the email.",
    },
    revoked: {
      title: "That invitation was withdrawn",
      body: "Whoever invited you cancelled this link, or sent you a newer one that replaced it. Ask them for a fresh invitation if you still want to join.",
    },
    accepted: {
      title: "That invitation was already used",
      body: "This link has already done its job — most likely by you, on another device or an earlier visit. If that's the case you already have an account; sign in below instead.",
    },
    expired: {
      title: "That invitation has expired",
      body: "Invitations last seven days, and this one has run out. Ask whoever sent it to invite you again.",
    },
  };
  const { title, body } = copy[state];

  return (
    <div className="card" style={{ maxWidth: 380, margin: "3rem auto" }}>
      <h1>{title}</h1>
      <p style={{ color: "var(--muted)" }}>{body}</p>
      {state === "accepted" && (
        <p style={{ marginTop: 16 }}>
          <Link href="/login">Sign in</Link>
        </p>
      )}
    </div>
  );
}
