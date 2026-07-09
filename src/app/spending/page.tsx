"use client";

import { useEffect, useRef, useState } from "react";

// Spending ledger + trend (§7, §8). Log a trip (date, store, typed total,
// receipt photo) and see this-week / this-month sums. The weekly bar chart +
// rolling average (§8) is a later refinement.

interface Trip {
  id: string;
  date: string;
  store: string;
  total: string | number;
  receipt: { id: string } | null;
}

function money(n: number): string {
  return `${n.toFixed(2)} kr`;
}

/** Monday 00:00 (local) of the current week. */
function startOfWeek(): Date {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return d;
}
function startOfMonth(): Date {
  const d = new Date();
  return new Date(d.getFullYear(), d.getMonth(), 1);
}

export default function SpendingPage() {
  const [trips, setTrips] = useState<Trip[] | null>(null);
  const [busy, setBusy] = useState(false);
  const formRef = useRef<HTMLFormElement>(null);

  async function load() {
    setTrips(await fetch("/api/trips").then((r) => r.json()));
  }
  useEffect(() => {
    load();
  }, []);

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    try {
      const res = await fetch("/api/trips", {
        method: "POST",
        body: new FormData(e.currentTarget),
      });
      if (res.ok) {
        formRef.current?.reset();
        await load();
      }
    } finally {
      setBusy(false);
    }
  }

  const weekStart = startOfWeek();
  const monthStart = startOfMonth();
  const sumSince = (since: Date) =>
    (trips ?? [])
      .filter((t) => new Date(t.date) >= since)
      .reduce((acc, t) => acc + Number(t.total), 0);

  const today = new Date().toISOString().slice(0, 10);

  return (
    <>
      <h1>Spending</h1>

      <div className="card">
        <h2>Log a trip</h2>
        <form ref={formRef} onSubmit={submit}>
          <div style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "end" }}>
            <label>
              Date
              <br />
              <input type="date" name="date" defaultValue={today} required />
            </label>
            <label>
              Store
              <br />
              <input type="text" name="store" placeholder="e.g. Netto" required />
            </label>
            <label>
              Total (kr)
              <br />
              <input type="number" name="total" step="0.01" min="0" required style={{ width: 110 }} />
            </label>
            <label>
              Receipt photo
              <br />
              <input type="file" name="photo" accept="image/*" />
            </label>
            <button type="submit" disabled={busy}>
              {busy ? "Saving…" : "Log trip"}
            </button>
          </div>
        </form>
      </div>

      <div className="card">
        <div style={{ display: "flex", gap: 32 }}>
          <div>
            <div className="muted">This week</div>
            <strong style={{ fontSize: "1.4em" }}>{money(sumSince(weekStart))}</strong>
          </div>
          <div>
            <div className="muted">This month</div>
            <strong style={{ fontSize: "1.4em" }}>{money(sumSince(monthStart))}</strong>
          </div>
        </div>
        {/* TODO: weekly-spend bar chart + rolling average (§8). */}
      </div>

      <div className="card">
        <h2>Trips</h2>
        {!trips ? (
          <p className="muted">Loading…</p>
        ) : trips.length === 0 ? (
          <p className="muted">No trips logged yet.</p>
        ) : (
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <tbody>
              {trips.map((t) => (
                <tr key={t.id} style={{ borderTop: "1px solid var(--border)" }}>
                  <td style={{ padding: "6px 8px" }}>{t.date.slice(0, 10)}</td>
                  <td style={{ padding: "6px 8px" }}>{t.store}</td>
                  <td style={{ padding: "6px 8px", textAlign: "right" }}>
                    {money(Number(t.total))}
                  </td>
                  <td style={{ padding: "6px 8px" }}>
                    {t.receipt ? (
                      <a href={`/api/trips/${t.id}/receipt`} target="_blank" rel="noreferrer">
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img
                          src={`/api/trips/${t.id}/receipt`}
                          alt="receipt"
                          style={{ height: 32, borderRadius: 4, verticalAlign: "middle" }}
                        />
                      </a>
                    ) : (
                      <span className="muted">—</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}
