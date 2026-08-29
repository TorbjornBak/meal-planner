"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { recipeImageSrc } from "@/lib/recipeImage";
import { searchRecipes } from "@/lib/recipeSearch";
import { formatDurationMinutes } from "@/lib/durations";

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

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * The Monday of the week we are in, as the same UTC-midnight instant the API
 * measures weeks in (`WeekPlan.weekStart` is a date-only column holding a
 * Monday, §3).
 *
 * Built from the *local* calendar date and then read as UTC — the same trick
 * the plan page's `mondayKey` uses. Taking `getUTCDate()` of a local `new
 * Date()` would put a Copenhagen evening on tomorrow's date half the year, and
 * every Sunday night the whole library would age by a week.
 */
function thisMondayUtc(now: Date): number {
  const today = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
  return today - ((now.getDay() + 6) % 7) * 86_400_000;
}

/**
 * "Last cooked 3 weeks ago" — the answer to "what haven't we made in ages",
 * which the app has always known and never said out loud.
 *
 * Both ends are exact UTC midnights, so the division is whole and the rounding
 * is only belt-and-braces. A week still to come is a dinner already booked, not
 * one cooked, and says so: without that, next week's plan would read as "last
 * cooked -1 weeks ago".
 *
 * Anything past a year collapses into one phrase. "Last cooked 137 weeks ago"
 * is arithmetic nobody can feel, and the sort below still keeps the oldest of
 * them first.
 */
function lastCookedLabel(lastCookedOn: string | null, thisMonday: number): string {
  if (!lastCookedOn) return "Never cooked";
  const weeks = Math.round((thisMonday - Date.parse(lastCookedOn)) / WEEK_MS);
  if (weeks < -1) return `On the plan in ${-weeks} weeks`;
  if (weeks === -1) return "On next week's plan";
  if (weeks === 0) return "Last cooked this week";
  if (weeks === 1) return "Last cooked last week";
  if (weeks >= 52) return "Last cooked over a year ago";
  return `Last cooked ${weeks} weeks ago`;
}

/** The exact week behind the label, for the tooltip. Read as UTC because that
 * is how the week was stored — rendering it locally would show the Sunday. */
function weekOfLabel(lastCookedOn: string): string {
  return `Week of ${new Date(lastCookedOn).toLocaleDateString(undefined, {
    timeZone: "UTC",
    day: "numeric",
    month: "short",
    year: "numeric",
  })}`;
}

/**
 * How long the dish takes, phrased as honestly as it was arrived at (§2).
 * A time the source page declared is stated flat; one we reached by adding up
 * the step timers is hedged with "about", because summing overlapping steps
 * overstates a recipe — the rule `Recipe.totalTimeIsEstimate` exists to carry.
 */
function cookTimeLabel(recipe: Recipe): string | null {
  if (recipe.totalTimeMinutes == null) return null;
  const time = formatDurationMinutes(recipe.totalTimeMinutes);
  return recipe.totalTimeIsEstimate ? `about ${time}` : time;
}

/**
 * How the list is ordered. An explicit control rather than a smart default:
 * favourites-first is the shelf you reach for most days, and staleness is a
 * question you ask deliberately, when the week won't fill itself.
 */
type SortOrder = "favorites" | "leastRecent";

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
  /// Whole-dish time in minutes, and whether it is our own sum of the step
  /// timers rather than a number the source stated. Null when nobody knows.
  totalTimeMinutes: number | null;
  totalTimeIsEstimate: boolean;
  /// The Monday of the most recent week this recipe was on the plan (§3), as
  /// the API's ISO string; null means it has never been on one.
  lastCookedOn: string | null;
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
  const [sort, setSort] = useState<SortOrder>("favorites");
  const [added, setAdded] = useState<Record<string, string>>({});

  // Read once per render rather than per row, so a list rendered across
  // midnight can't age half its recipes by a week mid-paint.
  const thisMonday = useMemo(() => thisMondayUtc(new Date()), []);

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

  // AND filter: a recipe must match every chip. The matching itself is
  // `searchRecipes` (§2), the same function the plan page's picker uses, so
  // "blomkål" means the same thing on both screens — including the Danish
  // folding, which is why a chip typed "blomkaal" now works too.
  //
  // One chip per pass rather than one query of all of them: `searchRecipes`
  // splits a query on whitespace and ANDs the words separately, but a chip is
  // one phrase — "hakket oksekød" must keep matching as it always did.
  const filtered = useMemo(() => {
    if (!recipes) return [];
    let rows = recipes;
    for (const f of filters) rows = searchRecipes(rows, f).map((m) => m.recipe);
    return rows;
  }, [recipes, filters]);

  // "Favourites first" is the order the API already sent (favourites, then
  // name), so the default costs nothing and the list you know stays put.
  //
  // "Least recently cooked" puts never-cooked recipes at the very top: a recipe
  // nobody has ever made is staler than any recipe we made once, and it is the
  // one most in need of attention — that is the whole point of the sort. It
  // falls out of treating "never" as infinitely long ago rather than as a
  // missing value to be shuffled to the end. Ties — a week that held several
  // dinners — break by name, so the order is stable between renders.
  const sorted = useMemo(() => {
    if (sort === "favorites") return filtered;
    return [...filtered].sort((a, b) => {
      const at = a.lastCookedOn ? Date.parse(a.lastCookedOn) : -Infinity;
      const bt = b.lastCookedOn ? Date.parse(b.lastCookedOn) : -Infinity;
      // Compared, never subtracted: -Infinity minus -Infinity is NaN, and a
      // NaN comparator silently leaves the never-cooked ones wherever they lay.
      if (at !== bt) return at < bt ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
  }, [filtered, sort]);

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
          Add ingredients to narrow the list to recipes that contain all of them
          — a word from the recipe's name works too.
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

      {sorted.length === 0 ? (
        <p className="muted">
          {filters.length ? "No recipes match those ingredients." : "Nothing saved yet."}
        </p>
      ) : (
        <>
        <div
          style={{
            display: "flex",
            gap: 6,
            alignItems: "center",
            justifyContent: "flex-end",
            margin: "12px 0",
          }}
        >
          <label className="muted" htmlFor="recipe-sort">
            Sort
          </label>
          <select
            id="recipe-sort"
            value={sort}
            onChange={(e) => setSort(e.target.value as SortOrder)}
          >
            <option value="favorites">Favourites first</option>
            <option value="leastRecent">Least recently cooked</option>
          </select>
        </div>
        {sorted.map((r) => (
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
                  {cookTimeLabel(r) && ` · ${cookTimeLabel(r)}`}
                </span>

                {/* The staleness line the library was missing: the app has
                    always held this (a slot joins to its week) and never said
                    it. Italic when never cooked, because that is the row this
                    whole screen exists to surface. */}
                <span
                  title={r.lastCookedOn ? weekOfLabel(r.lastCookedOn) : undefined}
                  style={{ fontStyle: r.lastCookedOn ? "normal" : "italic" }}
                >
                  {lastCookedLabel(r.lastCookedOn, thisMonday)}
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
        ))}
        </>
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
