"use client";

import { useEffect, useState } from "react";
import Link from "next/link";

// Recipe library (§2) — browse, favorite, rename, delete, reuse. Search/tag
// filtering is still a later refinement; the actions below are live.

interface Recipe {
  id: string;
  name: string;
  source: string | null;
  statedServings: number;
  isFavorite: boolean;
  ingredients: unknown[];
}

export default function RecipesPage() {
  const [recipes, setRecipes] = useState<Recipe[] | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");

  async function load() {
    const rs = await fetch("/api/recipes").then((r) => r.json());
    setRecipes(rs);
  }
  useEffect(() => {
    load();
  }, []);

  async function patch(id: string, body: Partial<Recipe>) {
    setRecipes((rs) =>
      rs ? rs.map((r) => (r.id === id ? { ...r, ...body } : r)) : rs,
    );
    await fetch(`/api/recipes/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  async function remove(id: string, name: string) {
    if (!confirm(`Delete "${name}"? This can't be undone.`)) return;
    setRecipes((rs) => (rs ? rs.filter((r) => r.id !== id) : rs));
    await fetch(`/api/recipes/${id}`, { method: "DELETE" });
  }

  async function saveRename(id: string) {
    const name = editName.trim();
    setEditingId(null);
    if (name) await patch(id, { name });
    else await load(); // discard empty rename
  }

  if (!recipes) return <p className="muted">Loading…</p>;

  return (
    <>
      <h1>Recipes</h1>
      <p>
        <Link href="/recipes/new">+ Paste a new recipe</Link>
      </p>

      {recipes.length === 0 ? (
        <p className="muted">Nothing saved yet.</p>
      ) : (
        recipes.map((r) => (
          <div className="card" key={r.id}>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <button
                onClick={() => patch(r.id, { isFavorite: !r.isFavorite })}
                title={r.isFavorite ? "Unfavorite" : "Favorite"}
                aria-label="toggle favorite"
                style={{ background: "none", border: "none", cursor: "pointer", fontSize: "1.1em" }}
              >
                {r.isFavorite ? "★" : "☆"}
              </button>

              {editingId === r.id ? (
                <>
                  <input
                    value={editName}
                    onChange={(e) => setEditName(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && saveRename(r.id)}
                    autoFocus
                    style={{ flex: 1 }}
                  />
                  <button onClick={() => saveRename(r.id)}>Save</button>
                  <button className="muted" onClick={() => setEditingId(null)}>
                    Cancel
                  </button>
                </>
              ) : (
                <>
                  <strong style={{ flex: 1 }}>{r.name}</strong>
                  <button
                    className="muted"
                    onClick={() => {
                      setEditingId(r.id);
                      setEditName(r.name);
                    }}
                  >
                    Rename
                  </button>
                  <button className="muted" onClick={() => remove(r.id, r.name)}>
                    Delete
                  </button>
                </>
              )}
            </div>
            <div className="muted" style={{ marginTop: 4 }}>
              {r.ingredients.length} ingredients · serves {r.statedServings}
              {r.source ? ` · ${r.source}` : ""}
            </div>
          </div>
        ))
      )}

      {/* TODO: search box + tag filter. */}
    </>
  );
}
