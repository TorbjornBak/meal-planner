import { prisma } from "@/lib/prisma";

// Reads live data behind the shared-session gate — never statically rendered.
export const dynamic = "force-dynamic";

// Spending ledger + trend (§7, §8). Lists trips with this-week / this-month
// sums; the weekly-spend bar chart + rolling average are a later pass.
export default async function SpendingPage() {
  const trips = await prisma.shoppingTrip.findMany({
    orderBy: { date: "desc" },
    take: 50,
  });

  return (
    <>
      <h1>Spending</h1>
      <p className="muted">
        Each trip records date, store, total, and a receipt photo. No OCR, no
        line items.
      </p>

      {/* TODO: log-trip form (date, store, total, photo) → POST /api/trips. */}
      {/* TODO: this-week / this-month sums, weekly bar chart + rolling average. */}

      <div className="card">
        <h2>Trips</h2>
        {trips.length === 0 ? (
          <p className="muted">No trips logged yet.</p>
        ) : (
          <ul>
            {trips.map((t) => (
              <li key={t.id}>
                {t.date.toISOString().slice(0, 10)} — {t.store} — {String(t.total)}
              </li>
            ))}
          </ul>
        )}
      </div>
    </>
  );
}
