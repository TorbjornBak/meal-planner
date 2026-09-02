"use client";

import { useRef, useState } from "react";
import Link from "next/link";
import { TurnstileWidget, type TurnstileWidgetHandle } from "@/components/TurnstileWidget";
import { TURNSTILE_ACTIONS } from "@/lib/turnstileActions";

// "Forgot password" (§9) — ask for a reset link by email.
export default function ForgotPage() {
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [turnstileToken, setTurnstileToken] = useState<string | null>(null);
  const turnstileRef = useRef<TurnstileWidgetHandle>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!turnstileToken) {
      setError("Complete the verification before requesting a link.");
      return;
    }
    setBusy(true);
    try {
      const res = await fetch("/api/password/forgot", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, "cf-turnstile-response": turnstileToken }),
      });
      if (res.status === 403) {
        setError("Verification failed. Try again.");
        return;
      }
      if (res.status === 429) {
        setError("Too many requests. Wait a bit before trying again.");
        return;
      }
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
      turnstileRef.current?.reset();
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
            <TurnstileWidget
              ref={turnstileRef}
              action={TURNSTILE_ACTIONS.passwordForgot}
              onTokenChange={setTurnstileToken}
            />
            {error && <p style={{ color: "var(--accent)" }}>{error}</p>}
            <button type="submit" disabled={busy || !turnstileToken} style={{ marginTop: 12 }}>
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
