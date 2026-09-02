"use client";

import { useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { InvitationKind } from "@prisma/client";
import { invitationPath, type AcceptancePlan } from "@/lib/invitations";
import { TurnstileWidget, type TurnstileWidgetHandle } from "@/components/TurnstileWidget";
import { TURNSTILE_ACTIONS } from "@/lib/turnstileActions";

/**
 * Spend an invitation (§9).
 *
 * One form, three genuinely different situations, decided before this
 * component ever renders: `inspectInvitation` on the server has already
 * worked out whether accepting will create an account, attach a second
 * household to one that exists, or do nothing but sign somebody back in. What
 * varies here is only which fields are worth asking for and which sentence
 * explains why — the server decides the same three-way split again, for
 * real, when the form posts to /api/invitations/accept, so nothing here is
 * trusted to get the plan right, only to word it right.
 *
 * The invited address is shown as fixed text, never an input: it's what the
 * link is bound to, and a field that looked editable would suggest the server
 * might listen to it, which it doesn't — acceptance checks the token's own
 * address, not anything a form supplies.
 */
export function AcceptForm(props: {
  token: string;
  email: string;
  invitedName: string | null;
  kind: InvitationKind;
  householdName: string | null;
  invitedBy: string | null;
  plan: AcceptancePlan;
  askForPassword: boolean;
  askForHouseholdName: boolean;
  minLength: number;
}) {
  const {
    token,
    email,
    invitedName,
    kind,
    householdName,
    invitedBy,
    plan,
    askForPassword,
    askForHouseholdName,
    minLength,
  } = props;

  const router = useRouter();
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [name, setName] = useState(invitedName ?? "");
  const [newHouseholdName, setNewHouseholdName] = useState(householdName ?? "");
  const [error, setError] = useState<string | null>(null);
  // A visitor signed in under a different address gets a distinct dead end
  // rather than a generic error, because the fix isn't "try again" — it's
  // "sign out first" — and the two look identical unless we say so.
  const [mismatch, setMismatch] = useState(false);
  // The server-side twin of the page's own SignInRequired check
  // (page.tsx): normally caught before this form ever renders, but a
  // session that expires or signs out in another tab between the page load
  // and this submit would otherwise show a bare "something went wrong".
  const [signInRequired, setSignInRequired] = useState(false);
  const [busy, setBusy] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const [turnstileToken, setTurnstileToken] = useState<string | null>(null);
  const turnstileRef = useRef<TurnstileWidgetHandle>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    if (askForPassword && password !== confirm) {
      setError("Those two passwords don't match.");
      return;
    }
    if (askForHouseholdName && !newHouseholdName.trim()) {
      setError("Give the household a name.");
      return;
    }
    if (!turnstileToken) {
      setError("Complete the verification before accepting the invitation.");
      return;
    }

    setBusy(true);
    try {
      const res = await fetch("/api/invitations/accept", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          token,
          ...(askForPassword ? { password } : {}),
          ...(askForPassword && name.trim() ? { name: name.trim() } : {}),
          ...(askForHouseholdName ? { householdName: newHouseholdName.trim() } : {}),
          "cf-turnstile-response": turnstileToken,
        }),
      });
      const body = await res.json().catch(() => ({}));

      if (!res.ok) {
        if (res.status === 429) {
          setError("Too many attempts. Wait a bit and try again.");
          return;
        }
        if (res.status === 403) {
          setError("Verification failed. Try again.");
          return;
        }
        if (body.error === "email-mismatch") {
          setMismatch(true);
          return;
        }
        if (body.error === "sign-in-required") {
          setSignInRequired(true);
          return;
        }
        setError(
          body.error === "weak-password"
            ? body.message
            : body.error === "password-required"
              ? "Choose a password."
              : body.error === "household-name-required"
                ? "Give the household a name."
                : body.error === "expired" ||
                    body.error === "revoked" ||
                    body.error === "accepted" ||
                    body.error === "invalid-token"
                  ? "This link stopped working while you were filling this in. Reload the page to see why."
                  : "Something went wrong. Try again.",
        );
        return;
      }

      // Accepting signs us in and makes the joined household the active one,
      // so go straight into the app rather than back to a login form.
      router.push("/dashboard");
      router.refresh();
    } finally {
      turnstileRef.current?.reset();
      setBusy(false);
    }
  }

  /**
   * Sign the current session out and let the page reload itself.
   *
   * `router.refresh()` re-runs the server component this form lives inside,
   * which re-reads the invitation with no session attached — the same code
   * path a visitor with no account at all takes — so the ordinary form just
   * appears afterwards. Nobody has to be told to click the link a second time.
   */
  async function signOutAndRetry() {
    setSigningOut(true);
    try {
      await fetch("/api/logout", { method: "POST" });
      router.refresh();
      setMismatch(false);
    } finally {
      setSigningOut(false);
    }
  }

  if (signInRequired) {
    return (
      <div className="card" style={{ maxWidth: 380, margin: "3rem auto" }}>
        <h1>Sign in to accept this invitation</h1>
        <p style={{ color: "var(--muted)" }}>
          <strong>{email}</strong> already has a MealPlanner account, so this link only works from a
          browser signed in as that address. Sign in and reopen this link to finish joining —
          nothing about your password changes.
        </p>
        <p style={{ marginTop: 12 }}>
          <Link href={`/login?next=${encodeURIComponent(invitationPath(token))}`}>Sign in</Link>
        </p>
      </div>
    );
  }

  if (mismatch) {
    return (
      <div className="card" style={{ maxWidth: 380, margin: "3rem auto" }}>
        <h1>You&apos;re signed in as somebody else</h1>
        <p style={{ color: "var(--muted)" }}>
          This invitation is for <strong>{email}</strong>, but this browser is currently signed in
          under a different address. Sign out below and the form for accepting it will take its
          place — nothing about the invitation itself changes.
        </p>
        <button onClick={signOutAndRetry} disabled={signingOut} style={{ marginTop: 12 }}>
          {signingOut ? "Signing out…" : "Sign out"}
        </button>
      </div>
    );
  }

  return (
    <div className="card" style={{ maxWidth: 380, margin: "3rem auto" }}>
      <h1>{heading({ plan, kind, householdName })}</h1>
      <p style={{ color: "var(--muted)" }}>
        {lede({ plan, kind, householdName, invitedBy, askForPassword, askForHouseholdName })}
      </p>

      <p style={{ marginTop: 12, marginBottom: 0 }}>
        <span className="muted">Invited address</span>
        <br />
        <strong>{email}</strong>
      </p>

      <form onSubmit={submit} style={{ marginTop: 12 }}>
        {askForHouseholdName && (
          <label style={{ display: "block", marginBottom: 12 }}>
            Household name
            <input
              value={newHouseholdName}
              onChange={(e) => setNewHouseholdName(e.target.value)}
              placeholder="Our kitchen"
              required
              autoFocus
              style={{ display: "block", width: "100%", padding: "0.5rem", marginTop: 4 }}
            />
          </label>
        )}

        {askForPassword && (
          <>
            <label style={{ display: "block" }}>
              Your name (optional)
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Shown in the weekly email"
                autoFocus={!askForHouseholdName}
                style={{ display: "block", width: "100%", padding: "0.5rem", marginTop: 4 }}
              />
            </label>
            <label style={{ display: "block", marginTop: 12 }}>
              Choose a password
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="new-password"
                minLength={minLength}
                required
                style={{ display: "block", width: "100%", padding: "0.5rem", marginTop: 4 }}
              />
            </label>
            <label style={{ display: "block", marginTop: 12 }}>
              Confirm password
              <input
                type="password"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                autoComplete="new-password"
                minLength={minLength}
                required
                style={{ display: "block", width: "100%", padding: "0.5rem", marginTop: 4 }}
              />
            </label>
            <p style={{ color: "var(--muted)", fontSize: 13, marginTop: 8 }}>
              At least {minLength} characters.
            </p>
          </>
        )}

        {plan === "link-account" && (
          <p style={{ color: "var(--muted)", fontSize: 13 }}>
            You already have a MealPlanner account at this address. Your password is unchanged —
            accepting only adds {kind === "PLATFORM" ? "the new household" : "this household"} to
            the ones you belong to.
          </p>
        )}

        {plan === "already-a-member" && (
          <p style={{ color: "var(--muted)", fontSize: 13 }}>
            You&apos;re already a member of {householdName ?? "this household"}. Continuing won&apos;t
            change anything about your membership — it&apos;ll just sign you in.
          </p>
        )}

        {error && <p style={{ color: "var(--accent)" }}>{error}</p>}

        <TurnstileWidget
          ref={turnstileRef}
          action={TURNSTILE_ACTIONS.invitationAccept}
          onTokenChange={setTurnstileToken}
        />

        <button type="submit" disabled={busy || !turnstileToken} style={{ marginTop: 12 }}>
          {busy ? "Joining…" : buttonLabel({ plan, kind, householdName })}
        </button>
      </form>

      {plan === "already-a-member" && (
        <p style={{ marginTop: 12 }}>
          <Link href="/dashboard">Or just go home</Link>
        </p>
      )}
    </div>
  );
}

function heading(opts: {
  plan: AcceptancePlan;
  kind: InvitationKind;
  householdName: string | null;
}): string {
  if (opts.plan === "already-a-member") return "You're already in";
  if (opts.kind === "PLATFORM") return "Set up your household";
  return `Join ${opts.householdName ?? "the household"}`;
}

function lede(opts: {
  plan: AcceptancePlan;
  kind: InvitationKind;
  householdName: string | null;
  invitedBy: string | null;
  askForPassword: boolean;
  askForHouseholdName: boolean;
}): string {
  const by = opts.invitedBy ? `${opts.invitedBy} invited you` : "You've been invited";

  if (opts.plan === "already-a-member") {
    return `${by}, but you're already signed up for this one — there's nothing left to do.`;
  }

  if (opts.kind === "PLATFORM") {
    const start = `${by} to start a new household on this MealPlanner`;
    if (opts.askForPassword) {
      return `${start}. Choose a password and give it a name, and you'll be its first admin.`;
    }
    if (opts.askForHouseholdName) {
      return `${start}. Your existing MealPlanner password carries over — just give the household a name.`;
    }
    return `${start}. You'll be its first admin.`;
  }

  return `${by} to join ${opts.householdName ?? "their household"} on MealPlanner.`;
}

function buttonLabel(opts: {
  plan: AcceptancePlan;
  kind: InvitationKind;
  householdName: string | null;
}): string {
  if (opts.plan === "already-a-member") return "Continue";
  if (opts.kind === "PLATFORM") return "Create household";
  return `Join ${opts.householdName ?? "the household"}`;
}
