"use client";

import { useState } from "react";
import Link from "next/link";

// "Forgot password" (§9) — ask for a reset link by email.
export default function ForgotPage() {
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const res = await fetch("/api/password/forgot", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email }),
      });
      if (res.status === 503) {
        setError("This MealPlanner has no mail server configured, so it can't send a reset link.");
        return;
      }
      if (!res.ok) {
        setError("Something went wrong. Try again.");
        return;
      }
      setSent(true);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card" style={{ maxWidth: 380, margin: "3rem auto" }}>
      <h1>Reset your password</h1>
      {sent ? (
        <>
          {/* Worded so it says the same thing whether or not the address is
              registered — the server deliberately doesn't tell us. */}
          <p>
            If <strong>{email}</strong> has an account here, a link to choose a new password is on
            its way. It works for one hour.
          </p>
          <p style={{ fontSize: 14 }}>
            <Link href="/login">Back to sign in</Link>
          </p>
        </>
      ) : (
        <>
          <p style={{ color: "var(--muted)" }}>
            We&apos;ll email you a link to choose a new one.
          </p>
          <form onSubmit={submit}>
            <label>
              Email
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                autoComplete="username"
                autoFocus
                required
                style={{ display: "block", width: "100%", padding: "0.5rem", marginTop: 4 }}
              />
            </label>
            {error && <p style={{ color: "var(--accent)" }}>{error}</p>}
            <button type="submit" disabled={busy} style={{ marginTop: 12 }}>
              {busy ? "Sending…" : "Email me a link"}
            </button>
          </form>
          <p style={{ marginTop: 16, fontSize: 14 }}>
            <Link href="/login">Back to sign in</Link>
          </p>
        </>
      )}
    </div>
  );
}
