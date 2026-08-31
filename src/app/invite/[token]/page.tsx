import Link from "next/link";
import { inspectInvitation } from "@/lib/invitationService";
import { MIN_PASSWORD_LENGTH } from "@/lib/password";
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
 */
export default async function InvitePage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const invitation = await inspectInvitation(token);

  if (!invitation) return <DeadEnd state="invalid" />;
  if (invitation.state !== "live") return <DeadEnd state={invitation.state} />;

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
