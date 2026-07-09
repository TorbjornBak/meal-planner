"use client";

import { useEffect, useState } from "react";

// Settings (§4, §9) — household size (scales every recipe) and the pantry list
// (§5). The shared password lives in the environment, not here.

interface PantryItem {
  id: string;
  name: string;
}

export default function SettingsPage() {
  const [householdSize, setHouseholdSize] = useState<number | "">("");
  const [savedSize, setSavedSize] = useState<number | null>(null);
  const [pantry, setPantry] = useState<PantryItem[]>([]);
  const [newItem, setNewItem] = useState("");

  useEffect(() => {
    fetch("/api/settings")
      .then((r) => r.json())
      .then((s) => {
        setHouseholdSize(s.householdSize);
        setSavedSize(s.householdSize);
      });
    fetch("/api/pantry")
      .then((r) => r.json())
      .then(setPantry);
  }, []);

  async function saveSize() {
    if (householdSize === "" || householdSize < 1) return;
    const s = await fetch("/api/settings", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ householdSize }),
    }).then((r) => r.json());
    setSavedSize(s.householdSize);
  }

  async function addPantry(e: React.FormEvent) {
    e.preventDefault();
    const name = newItem.trim();
    if (!name) return;
    const item = await fetch("/api/pantry", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name }),
    }).then((r) => r.json());
    setNewItem("");
    // Upsert into local state (POST is idempotent by normalized name).
    setPantry((p) =>
      p.some((x) => x.id === item.id) ? p : [...p, item].sort((a, b) => a.name.localeCompare(b.name)),
    );
  }

  async function removePantry(id: string) {
    setPantry((p) => p.filter((x) => x.id !== id));
    await fetch(`/api/pantry?id=${id}`, { method: "DELETE" });
  }

  const dirty = householdSize !== "" && householdSize !== savedSize;

  return (
    <>
      <h1>Settings</h1>

      <div className="card">
        <h2>Household size</h2>
        <p className="muted">Every recipe scales from its stated servings to this.</p>
        <input
          type="number"
          min={1}
          value={householdSize}
          onChange={(e) =>
            setHouseholdSize(e.target.value === "" ? "" : Number(e.target.value))
          }
          style={{ width: 80 }}
        />{" "}
        <button onClick={saveSize} disabled={!dirty}>
          {dirty ? "Save" : "Saved"}
        </button>
      </div>

      <div className="card">
        <h2>Pantry — things we always have</h2>
        <p className="muted">
          Items matching these names get pulled out of the main shopping list into
          their own section.
        </p>

        <form onSubmit={addPantry} style={{ marginBottom: 8 }}>
          <input
            value={newItem}
            onChange={(e) => setNewItem(e.target.value)}
            placeholder="e.g. Salt"
          />{" "}
          <button type="submit">Add</button>
        </form>

        {pantry.length === 0 ? (
          <p className="muted">No pantry items yet.</p>
        ) : (
          <ul style={{ listStyle: "none", padding: 0 }}>
            {pantry.map((p) => (
              <li key={p.id} style={{ padding: "3px 0" }}>
                {p.name}{" "}
                <button
                  className="muted"
                  onClick={() => removePantry(p.id)}
                  style={{ fontSize: "0.85em" }}
                >
                  remove
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </>
  );
}
