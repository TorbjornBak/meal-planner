"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

/**
 * First run (§9) — create the household's first account.
 *
 * Only reachable while the instance has no accounts; once one exists the
 * server closes the route and this page sends you to sign in instead. Further
 * members are invited from Settings.
 */
export default function SetupPage() {
  const router = useRouter();
  const [checked, setChecked] = useState(false);
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    fetch("/api/setup")
      .then((r) => r.json())
      .then((d) => {
        if (!d.needsSetup) router.replace("/login");
        else setChecked(true);
      })
      .catch(() => setChecked(true));
  }, [router]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const res = await fetch("/api/setup", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, name, password }),
      });
      const body = await res.json().catch(() => ({}));

      if (!res.ok) {
        setError(
          body.error === "weak-password"
            ? body.message
            : body.error === "invalid-email"
              ? "That doesn't look like an email address."
              : body.error === "already-set-up"
                ? "This MealPlanner already has an account. Sign in instead."
                : "Something went wrong. Try again.",
        );
        return;
      }

      router.push("/dashboard");
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  if (!checked) return null;

  return (
    <div className="card" style={{ maxWidth: 400, margin: "3rem auto" }}>
      <h1>Set up MealPlanner</h1>
      <p style={{ color: "var(--muted)" }}>
        This is a fresh install. Create your account — you can invite the rest of the household
        from Settings afterwards.
      </p>
      <form onSubmit={submit}>
        <label>
          Your name <span style={{ color: "var(--muted)" }}>(optional)</span>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            autoComplete="name"
            style={{ display: "block", width: "100%", padding: "0.5rem", marginTop: 4 }}
          />
        </label>
        <label style={{ display: "block", marginTop: 12 }}>
          Email
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoComplete="username"
            required
            style={{ display: "block", width: "100%", padding: "0.5rem", marginTop: 4 }}
          />
        </label>
        <label style={{ display: "block", marginTop: 12 }}>
          Password
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="new-password"
            minLength={10}
            required
            style={{ display: "block", width: "100%", padding: "0.5rem", marginTop: 4 }}
          />
        </label>
        {error && <p style={{ color: "var(--accent)" }}>{error}</p>}
        <button type="submit" disabled={busy} style={{ marginTop: 12 }}>
          {busy ? "Creating…" : "Create account"}
        </button>
      </form>
    </div>
  );
}
