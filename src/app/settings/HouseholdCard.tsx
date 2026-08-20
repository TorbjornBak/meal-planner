"use client";

import { useEffect, useState } from "react";
import { MailDiagnosis, type Diagnosis } from "./MailDiagnosis";

/**
 * The household roster (§9).
 *
 * No roles: everyone who can sign in can invite and remove, the same way
 * everyone can edit the shopping list. Inviting creates the account and mails
 * a link to choose a password; until they do, they show as pending.
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
        setError(
          body.error === "already-a-member"
            ? "They're already in the household."
            : body.error === "invalid-email"
              ? "That doesn't look like an email address."
              : body.error === "mail-not-configured"
                ? "No mail server is configured, so the invitation can't be sent."
                : "Couldn't send that invitation.",
        );
        return;
      }
      setNote(`Invitation sent to ${body.email}.`);
      setEmail("");
      setName("");
      load();
    } finally {
      setBusy(false);
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

      <p className="muted" style={{ fontSize: "0.85em", marginTop: 8 }}>
        An invitation emails them a link to pick a password. It lasts seven days; inviting the
        same address again sends a fresh one.
      </p>
    </div>
  );
}
