"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { recipeImageSrc } from "@/lib/recipeImage";

// Recipe library (§2) — browse, favorite, rename, delete; filter by ingredient
// (tag-style); and add a recipe straight onto this week's meal plan (§3).

const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

// A source is a URL/domain if it starts with http(s) or looks like "host.tld".
function isSourceUrl(source: string): boolean {
  return /^https?:\/\//i.test(source) || /^[a-z0-9-]+(?:\.[a-z0-9-]+)+/i.test(source);
}
function sourceHref(source: string): string {
  return /^https?:\/\//i.test(source) ? source : `https://${source}`;
}
// Compact label for a source link — the bare hostname, so long URLs don't
// overflow the card on mobile.
function sourceLabel(source: string): string {
  try {
    return new URL(sourceHref(source)).hostname.replace(/^www\./, "");
  } catch {
    return source;
  }
}

interface Ingredient {
  name: string;
}
interface Recipe {
  id: string;
  name: string;
  source: string | null;
  statedServings: number;
  isFavorite: boolean;
  /// Set when we hold the photo's bytes; imageUrl when we only know where it
  /// lives. Either one means there's something to show.
  imageMime: string | null;
  imageUrl: string | null;
  ingredients: Ingredient[];
}
interface Slot {
  id: string;
  dayOfWeek: number;
  recipeId: string;
}
interface WeekPlan {
  id: string;
  slots: Slot[];
}

export default function RecipesPage() {
  const [recipes, setRecipes] = useState<Recipe[] | null>(null);
  const [plan, setPlan] = useState<WeekPlan | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [filters, setFilters] = useState<string[]>([]);
  const [filterInput, setFilterInput] = useState("");
  const [added, setAdded] = useState<Record<string, string>>({});

  async function loadRecipes() {
    setRecipes(await fetch("/api/recipes").then((r) => r.json()));
  }
  useEffect(() => {
    loadRecipes();
    fetch("/api/plan")
      .then((r) => r.json())
      .then(setPlan);
  }, []);

  // Distinct ingredient names for the search autocomplete.
  const suggestions = useMemo(() => {
    const set = new Set<string>();
    for (const r of recipes ?? [])
      for (const i of r.ingredients) set.add(i.name);
    return [...set].sort((a, b) => a.localeCompare(b));
  }, [recipes]);

  // AND filter: a recipe must contain every filter term (substring match).
  const filtered = useMemo(() => {
    if (!recipes) return [];
    if (filters.length === 0) return recipes;
    return recipes.filter((r) =>
      filters.every((f) =>
        r.ingredients.some((i) => i.name.toLowerCase().includes(f.toLowerCase())),
      ),
    );
  }, [recipes, filters]);

  function addFilter() {
    const f = filterInput.trim();
    if (f && !filters.includes(f)) setFilters([...filters, f]);
    setFilterInput("");
  }

  async function patch(id: string, body: Partial<Recipe>) {
    setRecipes((rs) => (rs ? rs.map((r) => (r.id === id ? { ...r, ...body } : r)) : rs));
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
    else await loadRecipes();
  }

  // Default the picker to the first night with no dinner yet, falling back to
  // Monday once the week is full — you can still stack a second dinner there.
  function nextEmptyDay(): number {
    const used = new Set(plan?.slots.map((s) => s.dayOfWeek));
    for (let d = 0; d < 7; d++) if (!used.has(d)) return d;
    return 0;
  }
  async function addToPlan(recipeId: string, dayOfWeek: number) {
    if (!plan) return;
    setAdded((a) => ({ ...a, [recipeId]: `Added to ${DAYS[dayOfWeek]} ✓` }));
    const res = await fetch("/api/plan", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ weekPlanId: plan.id, dayOfWeek, recipeId }),
    });
    const slot: Slot = await res.json();
    setPlan((p) => (p ? { ...p, slots: [...p.slots, slot] } : p));
  }

  if (!recipes) return <p className="muted">Loading…</p>;

  return (
    <>
      <h1>Recipes</h1>
      <p>
        <Link href="/recipes/new">+ Paste a new recipe</Link>
      </p>

      <div className="card">
        <h2>Find by ingredient</h2>
        <p className="muted">
          Add ingredients to narrow the list to recipes that contain all of them.
        </p>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
          {filters.map((f) => (
            <span
              key={f}
              style={{
                background: "var(--bg)",
                border: "1px solid var(--border)",
                borderRadius: 999,
                padding: "2px 10px",
              }}
            >
              {f}{" "}
              <button
                onClick={() => setFilters(filters.filter((x) => x !== f))}
                style={{ border: "none", background: "none", cursor: "pointer" }}
                aria-label={`remove ${f}`}
              >
                ✕
              </button>
            </span>
          ))}
          <input
            list="ingredient-suggestions"
            value={filterInput}
            onChange={(e) => setFilterInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === ",") {
                e.preventDefault();
                addFilter();
              }
            }}
            placeholder="e.g. blomkål"
          />
          <datalist id="ingredient-suggestions">
            {suggestions.map((s) => (
              <option key={s} value={s} />
            ))}
          </datalist>
        </div>
      </div>

      {filtered.length === 0 ? (
        <p className="muted">
          {filters.length ? "No recipes match those ingredients." : "Nothing saved yet."}
        </p>
      ) : (
        filtered.map((r) => (
          <div className="card recipe-row" key={r.id}>
            {/* Decorative: the recipe name beside it is the real link. */}
            <Link
              href={`/recipes/${r.id}`}
              className="recipe-thumb"
              tabIndex={-1}
              aria-hidden
            >
              {recipeImageSrc(r) ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={recipeImageSrc(r)!} alt="" loading="lazy" />
              ) : (
                <span className="recipe-thumb-empty">🍽</span>
              )}
            </Link>

            <div className="recipe-row-body">
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
                  <Link href={`/recipes/${r.id}`} style={{ flex: 1 }}>
                    <strong>{r.name}</strong>
                  </Link>
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
              <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                <span>
                  {r.ingredients.length} ingredients · serves {r.statedServings}
                </span>

                {plan && (
                  <span style={{ marginLeft: "auto", display: "flex", gap: 6, alignItems: "center" }}>
                    {added[r.id] ? (
                      <em>{added[r.id]}</em>
                    ) : (
                      <AddToPlan
                        defaultDay={nextEmptyDay()}
                        onAdd={(day) => addToPlan(r.id, day)}
                      />
                    )}
                  </span>
                )}
              </div>

              {r.source &&
                (isSourceUrl(r.source) ? (
                  <div style={{ marginTop: 2 }}>
                    <a
                      href={sourceHref(r.source)}
                      target="_blank"
                      rel="noreferrer"
                      title={r.source}
                    >
                      {sourceLabel(r.source)} ↗
                    </a>
                  </div>
                ) : (
                  <div style={{ marginTop: 2, overflowWrap: "anywhere" }}>{r.source}</div>
                ))}
            </div>
            </div>
          </div>
        ))
      )}
    </>
  );
}

function AddToPlan({
  defaultDay,
  onAdd,
}: {
  defaultDay: number;
  onAdd: (day: number) => void;
}) {
  const [day, setDay] = useState(defaultDay);
  return (
    <>
      <select value={day} onChange={(e) => setDay(Number(e.target.value))}>
        {DAYS.map((d, i) => (
          <option key={i} value={i}>
            {d}
          </option>
        ))}
      </select>
      <button onClick={() => onAdd(day)}>Add to plan</button>
    </>
  );
}
