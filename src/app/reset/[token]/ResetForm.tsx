"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

/**
 * Choose a new password against a one-time emailed reset link (§9).
 *
 * `minLength` is passed down from the server so the hint here can't drift out
 * of step with what src/lib/password.ts actually enforces.
 */
export function ResetForm({
  token,
  minLength,
}: {
  token: string;
  minLength: number;
}) {
  const router = useRouter();
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    if (password !== confirm) {
      setError("Those two passwords don't match.");
      return;
    }

    setBusy(true);
    try {
      const res = await fetch("/api/password/reset", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token, password }),
      });
      const body = await res.json().catch(() => ({}));

      if (!res.ok) {
        setError(
          res.status === 429
            ? "Too many attempts. Wait a bit and try again."
            : body.error === "weak-password"
              ? body.message
              : body.error === "invalid-token"
                ? "This link has expired or has already been used. Ask for a new one."
                : "Something went wrong. Try again.",
        );
        return;
      }

      // The reset signs us in, so go straight into the app.
      router.push("/");
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card" style={{ maxWidth: 380, margin: "3rem auto" }}>
      <h1>Choose a new password</h1>
      <form onSubmit={submit}>
        <label>
          New password
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="new-password"
            minLength={minLength}
            autoFocus
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
        {error && <p style={{ color: "var(--accent)" }}>{error}</p>}
        <button type="submit" disabled={busy} style={{ marginTop: 12 }}>
          {busy ? "Saving…" : "Save new password"}
        </button>
      </form>
    </div>
  );
}
