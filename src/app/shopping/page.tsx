"use client";

import { useEffect, useState } from "react";

// In-store checklist (§5, §6). Aggregated actionable items plus a separate
// "Pantry — check you have these" section. Tapping an item toggles its checked
// state, which persists server-side and is shared across household phones.

interface Item {
  id: string;
  displayName: string;
  quantity: number | null;
  unit: string | null;
  altQuantity: number | null;
  altUnit: string | null;
  checked: boolean;
  isPantry: boolean;
}
interface ShoppingList {
  id: string;
  items: Item[];
}

function amount(q: number | null, u: string | null): string {
  if (q == null) return "";
  return u ? `${q} ${u}` : `${q}`;
}

export default function ShoppingPage() {
  const [list, setList] = useState<ShoppingList | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    // Resolve the current week, then load its persisted list.
    (async () => {
      const plan = await fetch("/api/plan").then((r) => r.json());
      const sl = await fetch(`/api/shopping?weekPlanId=${plan.id}`).then((r) =>
        r.json(),
      );
      setList(sl);
      setLoaded(true);
    })();
  }, []);

  async function patch(item: Item, body: Partial<Item>) {
    if (!list) return;
    setList({
      ...list,
      items: list.items.map((i) => (i.id === item.id ? { ...i, ...body } : i)),
    });
    await fetch(`/api/shopping/${item.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  if (!loaded) return <p className="muted">Loading…</p>;

  if (!list || list.items.length === 0) {
    return (
      <>
        <h1>Shopping list</h1>
        <p className="muted">
          No list yet — assign some dinners on the <a href="/plan">Plan</a> page
          and hit &ldquo;Generate shopping list&rdquo;.
        </p>
      </>
    );
  }

  const toBuy = list.items.filter((i) => !i.isPantry);
  const pantry = list.items.filter((i) => i.isPantry);

  return (
    <>
      <h1>Shopping list</h1>
      <p className="muted">Tap to tick items off as you grab them.</p>

      <div className="card">
        <h2>To buy</h2>
        {toBuy.length === 0 ? (
          <p className="muted">Nothing — it&rsquo;s all pantry staples.</p>
        ) : (
          toBuy.map((item) => (
            <label
              key={item.id}
              style={{ display: "flex", gap: 8, padding: "12px 0", cursor: "pointer" }}
            >
              <input
                type="checkbox"
                checked={item.checked}
                onChange={(e) => patch(item, { checked: e.target.checked })}
              />
              <span
                style={{
                  textDecoration: item.checked ? "line-through" : "none",
                  color: item.checked ? "var(--muted)" : "inherit",
                }}
              >
                {item.displayName}
                {item.quantity != null && (
                  <span className="muted"> — {amount(item.quantity, item.unit)}</span>
                )}
                {item.altQuantity != null && (
                  <span className="muted"> + {amount(item.altQuantity, item.altUnit)}</span>
                )}
              </span>
            </label>
          ))
        )}
      </div>

      {pantry.length > 0 && (
        <div className="card">
          <h2>Pantry — check you have these</h2>
          <p className="muted">
            Matched against your pantry list and moved here (never deleted). Pull
            one back onto the main list if you&rsquo;ve run out.
          </p>
          {pantry.map((item) => (
            <div
              key={item.id}
              style={{ display: "flex", gap: 8, padding: "12px 0", alignItems: "center" }}
            >
              <span>
                {item.displayName}
                {item.quantity != null && (
                  <span className="muted"> — {amount(item.quantity, item.unit)}</span>
                )}
              </span>
              <button
                className="muted"
                onClick={() => patch(item, { isPantry: false })}
                style={{ fontSize: "0.85em" }}
              >
                need it this week →
              </button>
            </div>
          ))}
        </div>
      )}
    </>
  );
}
