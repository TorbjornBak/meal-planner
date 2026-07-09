"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

// Shared-password login (§9). Tailscale is the primary gate; this is a second
// factor. One password for the whole household.
export default function LoginPage() {
  const router = useRouter();
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const res = await fetch("/api/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password }),
    });
    if (res.ok) {
      router.push("/");
      router.refresh();
    } else {
      setError("Wrong password");
    }
  }

  return (
    <div className="card" style={{ maxWidth: 360, margin: "3rem auto" }}>
      <h1>MealPlanner</h1>
      <form onSubmit={submit}>
        <label>
          Household password
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoFocus
            style={{ display: "block", width: "100%", padding: "0.5rem", marginTop: 4 }}
          />
        </label>
        {error && <p style={{ color: "var(--accent)" }}>{error}</p>}
        <button type="submit" style={{ marginTop: 12 }}>
          Enter
        </button>
      </form>
    </div>
  );
}
