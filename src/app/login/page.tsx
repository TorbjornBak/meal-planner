"use client";

import { Suspense, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";

import { safeNextPath } from "@/lib/safeRedirect";

// Sign in (§9). An account gates entry and, since the multi-household work,
// also decides what there is to see: the session carries an active household
// and every query is scoped to it.
function LoginForm() {
  const router = useRouter();
  const params = useSearchParams();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const res = await fetch("/api/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, password }),
      });
      if (res.status === 429) {
        setError("Too many attempts. Wait a bit and try again.");
        return;
      }
      if (!res.ok) {
        setError("That email and password don't match.");
        return;
      }
      // Only follow a same-origin path, so a crafted ?next= can't bounce
      // someone straight off the tailnet to somewhere else. The check lives in
      // safeNextPath because "starts with / but not //" is not enough: a
      // browser reads `/\evil.com` as another origin entirely.
      //
      // The fallback is the dashboard rather than safeNextPath's own "/",
      // which is the public landing page: somebody who has just typed a
      // password is asking to be in the app, not to be shown the door they
      // came through.
      router.push(safeNextPath(params.get("next"), window.location.origin, "/dashboard"));
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card" style={{ maxWidth: 380, margin: "3rem auto" }}>
      <h1>MealPlanner</h1>
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
        <label style={{ display: "block", marginTop: 12 }}>
          Password
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
            required
            style={{ display: "block", width: "100%", padding: "0.5rem", marginTop: 4 }}
          />
        </label>
        {error && <p style={{ color: "var(--accent)" }}>{error}</p>}
        <button type="submit" disabled={busy} style={{ marginTop: 12 }}>
          {busy ? "Signing in…" : "Sign in"}
        </button>
      </form>
      <p style={{ marginTop: 16, fontSize: 14 }}>
        <Link href="/forgot">Forgot your password?</Link>
      </p>
    </div>
  );
}

export default function LoginPage() {
  // useSearchParams needs a Suspense boundary to keep the page prerenderable.
  return (
    <Suspense fallback={null}>
      <LoginForm />
    </Suspense>
  );
}
