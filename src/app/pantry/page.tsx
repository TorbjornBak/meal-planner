"use client";

import { useEffect, useMemo, useState } from "react";

/**
 * The pantry list (§5) — the household's curated "things we always have".
 *
 * Its own page rather than a corner of Settings: this is a list you read as
 * often as you edit it ("do we already count paprika as a staple?"), and until
 * now the only place the household could see it was indirectly, as the
 * "check you have these" section of a generated shopping list.
 *
 * Everything here is a thin client over /api/pantry. After every write we
 * re-read the server's copy instead of patching local state — the list is
 * shared between household phones, and a silent divergence here is exactly the
 * confusion this page exists to end.
 */

interface PantryItem {
  id: string;
  name: string;
}

/** Below this, a filter box is more clutter than help. */
const FILTER_THRESHOLD = 8;

export default function PantryPage() {
  const [items, setItems] = useState<PantryItem[] | null>(null);
  const [newItem, setNewItem] = useState("");
  const [filter, setFilter] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function load() {
    try {
      const res = await fetch("/api/pantry");
      const body = await res.json().catch(() => null);
      if (!res.ok || !Array.isArray(body)) {
        setError("Couldn't load the pantry list.");
        return;
      }
      setError(null);
      setItems(body);
    } catch {
      setError("Couldn't reach the server — the pantry list may be out of date.");
    }
  }

  useEffect(() => {
    load();
  }, []);

  async function add(e: React.FormEvent) {
    e.preventDefault();
    const name = newItem.trim();
    if (!name || busy) return;
    setBusy(true);
    try {
      const res = await fetch("/api/pantry", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name }),
      });
      if (!res.ok) {
        setError(`Couldn't add "${name}".`);
        return;
      }
      setNewItem("");
      // Adding is idempotent by normalized name, so re-reading also settles the
      // "was that already in here under a different spelling?" case.
      await load();
    } catch {
      setError(`Couldn't add "${name}" — no connection.`);
    } finally {
      setBusy(false);
    }
  }

  async function remove(item: PantryItem) {
    setItems((p) => p?.filter((x) => x.id !== item.id) ?? p);
    try {
      const res = await fetch(`/api/pantry?id=${item.id}`, { method: "DELETE" });
      if (!res.ok) setError(`Couldn't remove "${item.name}".`);
    } catch {
      setError(`Couldn't remove "${item.name}" — no connection.`);
    }
    await load();
  }

  const shown = useMemo(() => {
    if (!items) return [];
    const q = filter.trim().toLowerCase();
    if (!q) return items;
    return items.filter((i) => i.name.toLowerCase().includes(q));
  }, [items, filter]);

  return (
    <>
      <h1>Pantry</h1>
      <p className="muted">
        The things you always have in. Anything on this list gets pulled out of the
        main <a href="/shopping">shopping list</a> into its own &ldquo;check you have
        these&rdquo; section — moved, never silently dropped.
      </p>

      <div className="card">
        <form onSubmit={add} style={{ marginBottom: 12 }}>
          <input
            value={newItem}
            onChange={(e) => setNewItem(e.target.value)}
            placeholder="e.g. Salt"
            aria-label="Pantry item"
            style={{ minWidth: 200 }}
          />{" "}
          <button type="submit" disabled={busy || !newItem.trim()}>
            {busy ? "Adding…" : "Add"}
          </button>
        </form>

        {error && <p style={{ color: "var(--accent)" }}>{error}</p>}

        {items === null ? (
          <p className="muted">Loading…</p>
        ) : items.length === 0 ? (
          <p className="muted">
            Nothing in the pantry yet. Add the staples you never write on a shopping
            list — salt, oil, flour — and they&rsquo;ll stop cluttering it.
          </p>
        ) : (
          <>
            <div
              style={{
                display: "flex",
                alignItems: "baseline",
                gap: 8,
                flexWrap: "wrap",
                marginBottom: 4,
              }}
            >
              <h2 style={{ margin: 0 }}>
                {items.length} {items.length === 1 ? "thing" : "things"} we always have
              </h2>
              {items.length >= FILTER_THRESHOLD && (
                <input
                  value={filter}
                  onChange={(e) => setFilter(e.target.value)}
                  placeholder="Filter…"
                  aria-label="Filter pantry"
                  style={{ marginLeft: "auto", maxWidth: 160 }}
                />
              )}
            </div>

            {shown.length === 0 ? (
              <p className="muted">Nothing matches &ldquo;{filter.trim()}&rdquo;.</p>
            ) : (
              <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
                {shown.map((item) => (
                  <li
                    key={item.id}
                    style={{
                      padding: "8px 0",
                      borderBottom: "1px solid var(--border)",
                      display: "flex",
                      alignItems: "baseline",
                      gap: 8,
                    }}
                  >
                    <span>{item.name}</span>
                    <button
                      className="muted"
                      onClick={() => remove(item)}
                      style={{ fontSize: "0.85em", marginLeft: "auto" }}
                    >
                      remove
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </div>

      <p className="muted" style={{ fontSize: "0.85em" }}>
        Matching is by ingredient name, ignoring case, punctuation and a trailing
        &ldquo;s&rdquo;. A list already generated for this week keeps the pantry it was
        built with — regenerate it from the <a href="/plan">Plan</a> page to apply
        changes made here.
      </p>
    </>
  );
}
