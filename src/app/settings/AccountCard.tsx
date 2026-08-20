"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

/**
 * Your own account (§9) — name, email, password, and the weekly digest
 * opt-in (§9b).
 */

interface Account {
  id: string;
  email: string;
  name: string | null;
  newsletterOptIn: boolean;
  mailConfigured: boolean;
}

export function AccountCard() {
  const router = useRouter();
  const [account, setAccount] = useState<Account | null>(null);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Password change.
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [pwError, setPwError] = useState<string | null>(null);
  const [pwNote, setPwNote] = useState<string | null>(null);

  const [previewing, setPreviewing] = useState(false);

  useEffect(() => {
    fetch("/api/account")
      .then((r) => r.json())
      .then((a: Account) => {
        setAccount(a);
        setName(a.name ?? "");
        setEmail(a.email);
      })
      .catch(() => {});
  }, []);

  async function saveProfile() {
    setError(null);
    setNote(null);
    const res = await fetch("/api/account", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name, email }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      setError(
        body.error === "email-taken"
          ? "Another member already uses that address."
          : body.error === "invalid-email"
            ? "That doesn't look like an email address."
            : "Couldn't save that.",
      );
      return;
    }
    setAccount((a) => (a ? { ...a, ...body } : a));
    setNote("Saved.");
  }

  async function toggleNewsletter(next: boolean) {
    setAccount((a) => (a ? { ...a, newsletterOptIn: next } : a));
    await fetch("/api/account", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ newsletterOptIn: next }),
    });
  }

  async function changePassword(e: React.FormEvent) {
    e.preventDefault();
    setPwError(null);
    setPwNote(null);
    const res = await fetch("/api/account/password", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ currentPassword, newPassword }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      setPwError(
        body.error === "wrong-password"
          ? "That isn't your current password."
          : body.error === "weak-password"
            ? body.message
            : "Couldn't change the password.",
      );
      return;
    }
    setCurrentPassword("");
    setNewPassword("");
    setPwNote("Password changed. Your other devices have been signed out.");
  }

  async function sendPreview() {
    setPreviewing(true);
    setNote(null);
    setError(null);
    try {
      const res = await fetch("/api/newsletter/preview", { method: "POST" });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(
          body.error === "mail-not-configured"
            ? "No mail server is configured on this instance."
            : "Couldn't send it — check the SMTP settings and the server log.",
        );
        return;
      }
      setNote(`Sent to ${body.to}.`);
    } finally {
      setPreviewing(false);
    }
  }

  async function signOut() {
    await fetch("/api/logout", { method: "POST" });
    router.push("/login");
    router.refresh();
  }

  if (!account) return null;

  return (
    <>
      <div className="card">
        <h2>Your account</h2>

        <label style={{ display: "block" }}>
          Name
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Shown in your weekly email"
            style={{ display: "block", marginTop: 4, width: "100%", maxWidth: 320 }}
          />
        </label>

        <label style={{ display: "block", marginTop: 12 }}>
          Email
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            style={{ display: "block", marginTop: 4, width: "100%", maxWidth: 320 }}
          />
        </label>

        <p style={{ marginTop: 12 }}>
          <button onClick={saveProfile}>Save</button>{" "}
          <button className="muted" onClick={signOut}>
            Sign out
          </button>
        </p>

        {note && <p className="muted">{note}</p>}
        {error && <p style={{ color: "var(--accent)" }}>{error}</p>}
      </div>

      <div className="card">
        <h2>Change password</h2>
        <form onSubmit={changePassword}>
          <label style={{ display: "block" }}>
            Current password
            <input
              type="password"
              value={currentPassword}
              onChange={(e) => setCurrentPassword(e.target.value)}
              autoComplete="current-password"
              required
              style={{ display: "block", marginTop: 4, width: "100%", maxWidth: 320 }}
            />
          </label>
          <label style={{ display: "block", marginTop: 12 }}>
            New password
            <input
              type="password"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              autoComplete="new-password"
              minLength={10}
              required
              style={{ display: "block", marginTop: 4, width: "100%", maxWidth: 320 }}
            />
          </label>
          <p className="muted" style={{ fontSize: "0.85em", marginTop: 6 }}>
            At least 10 characters. Changing it signs out every other device.
          </p>
          {pwError && <p style={{ color: "var(--accent)" }}>{pwError}</p>}
          {pwNote && <p className="muted">{pwNote}</p>}
          <button type="submit" style={{ marginTop: 8 }}>
            Change password
          </button>
        </form>
      </div>

      <div className="card">
        <h2>Weekly email</h2>
        <p className="muted">
          Once a week: the coming week&apos;s dinners and any recipes added to the library.
        </p>

        <label style={{ display: "block", marginTop: 8 }}>
          <input
            type="checkbox"
            checked={account.newsletterOptIn}
            onChange={(e) => toggleNewsletter(e.target.checked)}
          />{" "}
          Email me the weekly plan
        </label>

        {account.mailConfigured ? (
          <p style={{ marginTop: 12 }}>
            <button onClick={sendPreview} disabled={previewing}>
              {previewing ? "Sending…" : "Send me one now"}
            </button>
          </p>
        ) : (
          <p className="muted" style={{ marginTop: 12, fontSize: "0.85em" }}>
            No mail server is configured on this instance, so nothing will be sent. Set{" "}
            <code>SMTP_HOST</code>, <code>MAIL_FROM</code> and <code>APP_URL</code> to enable it.
          </p>
        )}
      </div>
    </>
  );
}
