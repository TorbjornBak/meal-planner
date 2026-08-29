"use client";

import { useEffect, useState } from "react";

// In-store checklist (§5, §6). Aggregated actionable items plus a separate
// "Pantry — check you have these" section. Tapping an item toggles its checked
// state, which persists server-side and is shared across household phones.
//
// Most lines are derived from the week's dinners, but the shop isn't only
// dinner: an item can also be typed straight onto the list (§5). Those are
// marked, and they're the only ones with a remove control — a derived line
// would reappear the next time the list is generated, so offering to delete it
// would be a lie. The server refuses that too; this just doesn't ask.

interface Item {
  id: string;
  displayName: string;
  quantity: number | null;
  unit: string | null;
  altQuantity: number | null;
  altUnit: string | null;
  checked: boolean;
  isPantry: boolean;
  /** Typed in by hand rather than derived from a planned dinner. */
  isManual: boolean;
}
interface ShoppingList {
  id: string;
  items: Item[];
}

function amount(q: number | null, u: string | null): string {
  if (q == null) return "";
  return u ? `${q} ${u}` : `${q}`;
}

/* Quiet enough to ignore in the aisle, loud enough to explain the × beside it. */
const badge: React.CSSProperties = {
  marginLeft: 6,
  padding: "0.05rem 0.4rem",
  border: "1px solid var(--border)",
  borderRadius: 6,
  fontSize: "0.75em",
  color: "var(--muted)",
  whiteSpace: "nowrap",
};

export default function ShoppingPage() {
  const [planId, setPlanId] = useState<string | null>(null);
  const [list, setList] = useState<ShoppingList | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [newItem, setNewItem] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  async function load(weekPlanId: string) {
    const sl = await fetch(`/api/shopping?weekPlanId=${weekPlanId}`).then((r) =>
      r.json(),
    );
    setList(sl);
  }

  useEffect(() => {
    // Resolve the current week, then load its persisted list.
    (async () => {
      const plan = await fetch("/api/plan").then((r) => r.json());
      setPlanId(plan.id);
      await load(plan.id);
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

  async function add(e: React.FormEvent) {
    e.preventDefault();
    const name = newItem.trim();
    if (!name || !planId || busy) return;
    setBusy(true);
    setNote(null);
    try {
      const res = await fetch("/api/shopping/items", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ weekPlanId: planId, name }),
      });
      if (!res.ok) {
        setNote(`Couldn't add "${name}".`);
        return;
      }
      // 200 rather than 201 means the name normalized onto a line that was
      // already there — say so, or it looks like nothing happened.
      if (res.status === 200) setNote(`"${name}" is already on the list.`);
      setNewItem("");
      await load(planId);
    } catch {
      setNote(`Couldn't add "${name}" — no connection.`);
    } finally {
      setBusy(false);
    }
  }

  async function remove(item: Item) {
    if (!planId) return;
    setNote(null);
    try {
      const res = await fetch(`/api/shopping/${item.id}`, { method: "DELETE" });
      if (!res.ok) {
        // The server's refusal explains itself (a derived line comes back on
        // the next generation); pass it straight through rather than paraphrase.
        const body = await res.json().catch(() => null);
        setNote(body?.error ?? `Couldn't remove "${item.displayName}".`);
      }
    } catch {
      setNote(`Couldn't remove "${item.displayName}" — no connection.`);
    }
    await load(planId);
  }

  if (!loaded) return <p className="muted">Loading…</p>;

  const items = list?.items ?? [];
  const toBuy = items.filter((i) => !i.isPantry);
  const pantry = items.filter((i) => i.isPantry);

  return (
    <>
      <h1>Shopping list</h1>
      <p className="muted">Tap to tick items off as you grab them.</p>

      <div className="card">
        <h2>To buy</h2>

        <form onSubmit={add} style={{ marginBottom: 4 }}>
          <input
            value={newItem}
            onChange={(e) => setNewItem(e.target.value)}
            placeholder="e.g. Kitchen roll"
            aria-label="Add an item to the list"
            style={{ minWidth: 200 }}
          />{" "}
          <button type="submit" disabled={busy || !newItem.trim() || !planId}>
            {busy ? "Adding…" : "Add"}
          </button>
        </form>
        <p className="muted" style={{ fontSize: "0.9em", marginTop: 4 }}>
          For the things no dinner asks for. Added items stay on the list when
          it&rsquo;s regenerated, and merge in if a recipe turns out to need them.
        </p>

        {note && <p style={{ color: "var(--accent)" }}>{note}</p>}

        {toBuy.length === 0 ? (
          items.length === 0 ? (
            <p className="muted">
              Nothing here yet — assign some dinners on the{" "}
              <a href="/plan">Plan</a> page and hit &ldquo;Generate shopping
              list&rdquo;, or just add what you need above.
            </p>
          ) : (
            <p className="muted">Nothing — it&rsquo;s all pantry staples.</p>
          )
        ) : (
          toBuy.map((item) => (
            <div
              key={item.id}
              style={{ display: "flex", gap: 8, alignItems: "center" }}
            >
              {/* The label stops at the item so the remove button beside it
                  doesn't toggle the checkbox. */}
              <label
                style={{
                  display: "flex",
                  gap: 8,
                  padding: "12px 0",
                  cursor: "pointer",
                  flex: 1,
                  minWidth: 0,
                }}
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
                  {item.isManual && <span style={badge}>added by hand</span>}
                </span>
              </label>
              {item.isManual && (
                <button
                  className="muted"
                  onClick={() => remove(item)}
                  aria-label={`Remove ${item.displayName} from the list`}
                  title="Remove from the list"
                >
                  ×
                </button>
              )}
            </div>
          ))
        )}
      </div>

      {pantry.length > 0 && (
        <div className="card">
          <h2>Pantry — check you have these</h2>
          <p className="muted">
            Matched against your <a href="/pantry">pantry list</a> and moved here
            (never deleted). Pull one back onto the main list if you&rsquo;ve run out.
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
