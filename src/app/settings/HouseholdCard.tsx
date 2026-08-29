"use client";

import { useEffect, useState } from "react";
import { MailDiagnosis, type Diagnosis } from "./MailDiagnosis";

/**
 * The household roster (§9).
 *
 * No roles: everyone who can sign in can invite and remove, the same way
 * everyone can edit the shopping list. Inviting creates the account and mails
 * a link to choose a password; until they do, they show as pending.
 *
 * On an instance with no SMTP server the account is still created and the link
 * still valid — it just comes back in the response instead of an inbox, and
 * this card shows it so the member can pass it on by whatever they already use
 * to talk to each other.
 */

interface Member {
  id: string;
  email: string;
  name: string | null;
  newsletterOptIn: boolean;
  pending: boolean;
  lastLoginAt: string | null;
  isMe: boolean;
}

export function HouseholdCard() {
  const [members, setMembers] = useState<Member[] | null>(null);
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [diagnosis, setDiagnosis] = useState<Diagnosis | null>(null);
  // An invitation that was created but not delivered, plus whether the copy
  // button managed to reach the clipboard.
  const [undelivered, setUndelivered] = useState<{ email: string; url: string } | null>(null);
  const [copied, setCopied] = useState<"yes" | "no" | null>(null);
  const [busy, setBusy] = useState(false);

  function load() {
    fetch("/api/users")
      .then((r) => r.json())
      .then(setMembers)
      .catch(() => {});
  }

  useEffect(load, []);

  async function invite(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setNote(null);
    setDiagnosis(null);
    setUndelivered(null);
    setCopied(null);
    setBusy(true);
    try {
      const res = await fetch("/api/users", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, name }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        if (body.error === "mail-failed") {
          // The server worked out why; show that rather than "check the SMTP
          // settings", which is only ever true and never useful.
          setDiagnosis({ summary: body.summary, hint: body.hint, detail: body.detail });
          return;
        }
        // No "mail isn't configured" case here any more: an instance without a
        // mail server hands the link back instead of refusing the invitation.
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
        setNote(`Invitation sent to ${body.user.email}.`);
      } else {
        setUndelivered({ email: body.user.email, url: body.inviteUrl });
      }
      setEmail("");
      setName("");
      load();
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
      const body = await res.json().catch(() => ({}));
      setError(
        body.error === "last-member"
          ? "You can't remove the only account."
          : "Couldn't remove them.",
      );
      return;
    }
    load();
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
              {m.pending && (
                <span style={{ fontSize: "0.8em", color: "var(--accent)" }}>
                  invited — hasn&apos;t set a password
                </span>
              )}
              {!m.newsletterOptIn && (
                <span className="muted" style={{ fontSize: "0.8em" }}>
                  no weekly email
                </span>
              )}
              {!m.isMe && (
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

      {note && <p className="muted">{note}</p>}
      {error && <p style={{ color: "var(--accent)" }}>{error}</p>}
      {diagnosis && <MailDiagnosis d={diagnosis} />}

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
            {undelivered.email} is in the household. Email isn&apos;t set up on this instance, so
            nothing was sent — pass this link to them yourself. It lets them pick a password, and
            it stops working in seven days.
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

      <p className="muted" style={{ fontSize: "0.85em", marginTop: 8 }}>
        An invitation creates their account and sends a link to pick a password — or hands you
        the link, if this instance has no mail server. It lasts seven days; inviting the same
        address again issues a fresh one.
      </p>
    </div>
  );
}
