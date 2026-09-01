"use client";

import { useEffect, useState } from "react";
import { DiagnosisPanel, type Diagnosis } from "./Diagnosis";

/**
 * The household roster and its outstanding invitations (§9).
 *
 * Two admins, not zero: household admins can invite and remove, but not one
 * another — memberRemovalRefusal (src/lib/invitations.ts) is what actually
 * enforces that, and the server has already applied it by the time this
 * component sees a member's `removable` flag, so the button just follows
 * what it's told rather than re-deriving the rule. A plain member sees the
 * roster but no invite form and no invitations list at all: /api/invitations
 * answers 403 to anyone who isn't an admin, and this component treats that
 * answer as "there is nothing here for you" rather than as an error to show.
 *
 * Inviting no longer creates anything by itself. It used to create the
 * account up front and mail a password-choice link; now the invitation is
 * only an offer with a seven-day expiry, bound to one address, and nothing
 * about the household changes until the invitee opens the link and accepts
 * it. That is why this card fetches two separate lists rather than one: who
 * is actually in, and who has merely been asked.
 *
 * On an instance with no SMTP server the invitation still exists — it just
 * comes back in the response instead of an inbox, and this card shows it so
 * the admin can pass it on by whatever they already use to talk to the
 * person they're inviting.
 */

interface Member {
  id: string;
  email: string;
  name: string | null;
  lastLoginAt: string | null;
  newsletterOptIn: boolean;
  role: "ADMIN" | "MEMBER";
  createdAt: string;
  pending: boolean;
  isMe: boolean;
  removable: boolean;
}

interface PendingInvitation {
  id: string;
  email: string;
  invitedName: string | null;
  kind: "HOUSEHOLD" | "PLATFORM";
  invitedBy: string | null;
  expiresAt: string;
  createdAt: string;
}

/** "expires in 3 days", "expires today", or "lapsed" once the clock's run out. */
function expiryLabel(expiresAt: string): string {
  const msLeft = new Date(expiresAt).getTime() - Date.now();
  if (msLeft <= 0) return "lapsed";
  const days = Math.ceil(msLeft / (24 * 60 * 60 * 1000));
  return days <= 1 ? "expires today" : `expires in ${days} days`;
}

export function HouseholdCard() {
  const [members, setMembers] = useState<Member[] | null>(null);
  const [invitations, setInvitations] = useState<PendingInvitation[] | null>(null);
  // Known only once /api/invitations has answered: 403 means "not an admin",
  // anything else that succeeds means it is one. Kept apart from `invitations`
  // being null, which just means "hasn't loaded yet".
  const [isAdmin, setIsAdmin] = useState<boolean | null>(null);

  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [diagnosis, setDiagnosis] = useState<Diagnosis | null>(null);
  // An invitation that was created but not delivered, plus whether the copy
  // button managed to reach the clipboard.
  const [undelivered, setUndelivered] = useState<{ email: string; url: string } | null>(null);
  // The same "created but not delivered" situation, except the address
  // already has an account — so the server withheld the link rather than
  // handing this admin a bearer credential for somebody else's account. Kept
  // apart from `undelivered` because there is no link to show or copy here,
  // only an explanation.
  const [linkWithheld, setLinkWithheld] = useState<string | null>(null);
  const [copied, setCopied] = useState<"yes" | "no" | null>(null);
  const [busy, setBusy] = useState(false);

  function loadMembers() {
    fetch("/api/users")
      .then((r) => r.json())
      .then(setMembers)
      .catch(() => {});
  }

  function loadInvitations() {
    fetch("/api/invitations")
      .then(async (r) => {
        if (r.status === 403) {
          setIsAdmin(false);
          return;
        }
        if (!r.ok) return;
        setIsAdmin(true);
        setInvitations(await r.json());
      })
      .catch(() => {});
  }

  useEffect(() => {
    loadMembers();
    loadInvitations();
  }, []);

  async function invite(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setNote(null);
    setDiagnosis(null);
    setUndelivered(null);
    setLinkWithheld(null);
    setCopied(null);
    setBusy(true);
    try {
      const res = await fetch("/api/invitations", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, name }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        if (body.error === "mail-failed") {
          // The server worked out why; show that rather than "check the SMTP
          // settings", which is only ever true and never useful. The
          // invitation itself still stands — it's the mail that failed.
          setDiagnosis({ summary: body.summary, hint: body.hint, detail: body.detail });
          loadInvitations();
          return;
        }
        setError(
          body.error === "already-a-member"
            ? "They're already in the household."
            : body.error === "invalid-email"
              ? "That doesn't look like an email address."
              : "Couldn't send that invitation.",
        );
        return;
      }
      if (body.delivered) {
        setNote(`Invitation sent to ${body.invitation.email}.`);
      } else if (body.linkWithheld) {
        setLinkWithheld(body.invitation.email);
      } else {
        setUndelivered({ email: body.invitation.email, url: body.inviteUrl });
      }
      setEmail("");
      setName("");
      loadInvitations();
    } finally {
      setBusy(false);
    }
  }

  /**
   * Copy the invite link.
   *
   * The clipboard API is only available in a secure context, and a household
   * reaching the box over plain http on the tailnet isn't in one (§10). So the
   * link lives in a real input that can be selected by hand, and a refused copy
   * says so instead of silently doing nothing.
   */
  async function copyInvite(url: string) {
    try {
      await navigator.clipboard.writeText(url);
      setCopied("yes");
    } catch {
      setCopied("no");
    }
  }

  async function withdraw(inv: PendingInvitation) {
    if (!confirm(`Withdraw the invitation to ${inv.email}? The link will stop working right away.`)) {
      return;
    }
    const res = await fetch(`/api/invitations?id=${inv.id}`, { method: "DELETE" });
    if (!res.ok) {
      // 409 here means somebody beat us to it — accepted or already withdrawn
      // from another tab — so the honest fix is to reload the list, not to
      // report a failure for something that already happened.
      setError(null);
      loadInvitations();
      return;
    }
    loadInvitations();
  }

  async function remove(m: Member) {
    if (
      !confirm(
        `Remove ${m.name || m.email} from the household? They'll be signed out immediately. The plan, recipes and spending stay.`,
      )
    ) {
      return;
    }
    const res = await fetch(`/api/users?id=${m.id}`, { method: "DELETE" });
    if (!res.ok) {
      setError("Couldn't remove them.");
      return;
    }
    loadMembers();
  }

  return (
    <div className="card">
      <h2>Household members</h2>
      <p className="muted">
        Everyone here shares the same plan, recipe library and spending ledger — accounts are
        just how you sign in and where the weekly email goes.
      </p>

      {members === null ? (
        <p className="muted">Loading…</p>
      ) : (
        <ul style={{ listStyle: "none", padding: 0 }}>
          {members.map((m) => (
            <li
              key={m.id}
              style={{
                padding: "6px 0",
                borderBottom: "1px solid var(--border)",
                display: "flex",
                alignItems: "baseline",
                gap: 8,
                flexWrap: "wrap",
              }}
            >
              <span>
                {m.name ? `${m.name} ` : ""}
                <span className="muted">{m.email}</span>
              </span>
              {m.isMe && <span className="muted" style={{ fontSize: "0.8em" }}>you</span>}
              {m.role === "ADMIN" && (
                <span className="muted" style={{ fontSize: "0.8em" }}>
                  admin
                </span>
              )}
              {m.pending && (
                <span style={{ fontSize: "0.8em", color: "var(--accent)" }}>
                  hasn&apos;t set a password
                </span>
              )}
              {!m.newsletterOptIn && (
                <span className="muted" style={{ fontSize: "0.8em" }}>
                  no weekly email
                </span>
              )}
              {m.removable && (
                <button
                  className="muted"
                  onClick={() => remove(m)}
                  style={{ fontSize: "0.85em", marginLeft: "auto" }}
                >
                  remove
                </button>
              )}
            </li>
          ))}
        </ul>
      )}

      {isAdmin && (
        <p className="muted" style={{ fontSize: "0.85em" }}>
          Admins can&apos;t remove one another — that keeps the household from turning into a race
          between two people who share it. Leaving is a separate act from being removed, and isn&apos;t
          done from here yet.
        </p>
      )}

      {isAdmin && (
        <>
          {invitations !== null && invitations.length > 0 && (
            <>
              <h3 style={{ marginTop: 16, marginBottom: 4, fontSize: "1em" }}>
                Waiting to join
              </h3>
              <ul style={{ listStyle: "none", padding: 0 }}>
                {invitations.map((inv) => (
                  <li
                    key={inv.id}
                    style={{
                      padding: "6px 0",
                      borderBottom: "1px solid var(--border)",
                      display: "flex",
                      alignItems: "baseline",
                      gap: 8,
                      flexWrap: "wrap",
                    }}
                  >
                    <span>
                      {inv.invitedName ? `${inv.invitedName} ` : ""}
                      <span className="muted">{inv.email}</span>
                    </span>
                    <span className="muted" style={{ fontSize: "0.8em" }}>
                      invited by {inv.invitedBy ?? "someone no longer here"} ·{" "}
                      {expiryLabel(inv.expiresAt)}
                    </span>
                    <button
                      className="muted"
                      onClick={() => withdraw(inv)}
                      style={{ fontSize: "0.85em", marginLeft: "auto" }}
                    >
                      withdraw
                    </button>
                  </li>
                ))}
              </ul>
            </>
          )}

          <form onSubmit={invite} style={{ marginTop: 12 }}>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="their@email.example"
              required
              style={{ minWidth: 200 }}
            />{" "}
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Name (optional)"
            />{" "}
            <button type="submit" disabled={busy}>
              {busy ? "Sending…" : "Invite"}
            </button>
          </form>
        </>
      )}

      {note && <p className="muted">{note}</p>}
      {error && <p style={{ color: "var(--accent)" }}>{error}</p>}
      {diagnosis && <DiagnosisPanel d={diagnosis} />}

      {undelivered && (
        <div
          style={{
            marginTop: 10,
            padding: 10,
            border: "1px solid var(--border)",
            borderRadius: 6,
          }}
        >
          <p style={{ margin: "0 0 8px 0" }}>
            An invitation for {undelivered.email} was created, but email isn&apos;t set up on this
            instance, so nothing was sent — pass this link to them yourself. It lets them join,
            and it stops working in seven days.
          </p>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
            <input
              readOnly
              value={undelivered.url}
              onFocus={(e) => e.currentTarget.select()}
              style={{ flex: "1 1 260px", minWidth: 0 }}
            />
            <button type="button" onClick={() => copyInvite(undelivered.url)}>
              {copied === "yes" ? "Copied" : "Copy link"}
            </button>
          </div>
          {copied === "no" && (
            <p className="muted" style={{ margin: "6px 0 0 0", fontSize: "0.85em" }}>
              This browser wouldn&apos;t let the page reach the clipboard. Select the link above and
              copy it yourself.
            </p>
          )}
          <p className="muted" style={{ margin: "6px 0 0 0", fontSize: "0.85em" }}>
            To have invitations email themselves, set SMTP_HOST, MAIL_FROM and APP_URL on the
            server.
          </p>
        </div>
      )}

      {linkWithheld && (
        <div
          style={{
            marginTop: 10,
            padding: 10,
            border: "1px solid var(--border)",
            borderRadius: 6,
          }}
        >
          <p style={{ margin: 0 }}>
            An invitation for {linkWithheld} was created, but {linkWithheld} already has a
            MealPlanner account, and email isn&apos;t set up on this instance to deliver the link
            directly to them. For their protection, the link isn&apos;t shown here — anyone who
            saw it could sign in as their existing account, with no password. Set up SMTP and
            invite them again, and the link will go straight to their inbox instead.
          </p>
        </div>
      )}

      {isAdmin && (
        <p className="muted" style={{ fontSize: "0.85em", marginTop: 8 }}>
          An invitation doesn&apos;t create an account or add anyone to the household — it&apos;s an
          offer, good for seven days, that only the invited address can accept. Inviting the same
          address again replaces whatever link was outstanding for them, and withdrawing one stops
          it working immediately.
        </p>
      )}
    </div>
  );
}
