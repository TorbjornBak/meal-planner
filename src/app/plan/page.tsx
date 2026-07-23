"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { recipeImageSrc } from "@/lib/recipeImage";

// Weekly dinner plan (§3, §4), laid out as a calendar week. Assign one or more
// recipes to any night; leave nights empty for leftovers / eating out. Optional
// per-dinner servings override for guests or batch-cooking. Then generate the
// shopping list (§5).
//
// You can page backwards and forwards through weeks: the plan API upserts
// whichever week you ask for, so next week exists the moment you look at it.

const DAYS = [
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
  "Sunday",
];

interface SlotRecipe {
  id: string;
  name: string;
  imageMime: string | null;
  imageUrl: string | null;
}
interface Slot {
  id: string;
  dayOfWeek: number;
  recipeId: string;
  servingsOverride: number | null;
  recipe: SlotRecipe | null;
}
interface WeekPlan {
  id: string;
  weekStart: string;
  slots: Slot[];
}
interface RecipeOption {
  id: string;
  name: string;
  imageMime: string | null;
  imageUrl: string | null;
}

/** `YYYY-MM-DD` for the Monday of the week containing `d`, in UTC like the API. */
function mondayKey(d: Date): string {
  const utc = Date.UTC(d.getFullYear(), d.getMonth(), d.getDate());
  const monday = utc - ((d.getDay() + 6) % 7) * 86_400_000;
  return new Date(monday).toISOString().slice(0, 10);
}

/** The `YYYY-MM-DD` `days` after the given one. */
function addDays(key: string, days: number): string {
  return new Date(Date.parse(`${key}T00:00:00Z`) + days * 86_400_000)
    .toISOString()
    .slice(0, 10);
}

/** Day of the month, unpadded — the number in a calendar cell's corner. */
function dayNumber(key: string): string {
  return String(Number(key.slice(8, 10)));
}

/** "21–27 July" / "28 July – 3 August" for the week header. */
function weekLabel(weekStart: string): string {
  const start = new Date(`${weekStart}T00:00:00Z`);
  const end = new Date(`${addDays(weekStart, 6)}T00:00:00Z`);
  const month = (d: Date) =>
    d.toLocaleDateString(undefined, { month: "long", timeZone: "UTC" });

  return month(start) === month(end)
    ? `${start.getUTCDate()}–${end.getUTCDate()} ${month(end)}`
    : `${start.getUTCDate()} ${month(start)} – ${end.getUTCDate()} ${month(end)}`;
}

export default function PlanPage() {
  const router = useRouter();
  // Both read off the *local* calendar — "today" is the day you're living in,
  // even in the hours where that differs from UTC.
  const thisWeek = useMemo(() => mondayKey(new Date()), []);
  const today = useMemo(() => {
    const d = new Date();
    return new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()))
      .toISOString()
      .slice(0, 10);
  }, []);

  const [weekStart, setWeekStart] = useState(thisWeek);
  const [plan, setPlan] = useState<WeekPlan | null>(null);
  const [recipes, setRecipes] = useState<RecipeOption[]>([]);
  const [generating, setGenerating] = useState(false);

  useEffect(() => {
    fetch("/api/recipes")
      .then((r) => r.json())
      .then(setRecipes);
  }, []);

  useEffect(() => {
    let stale = false;
    // Cleared first: paging to another week shouldn't leave the old week's
    // dinners on screen looking like they belong to the new one.
    setPlan(null);
    fetch(`/api/plan?weekStart=${weekStart}`)
      .then((r) => r.json())
      .then((p) => {
        if (!stale) setPlan(p);
      });
    return () => {
      stale = true;
    };
  }, [weekStart]);

  // Add a dinner to a night. The server assigns its position (after any
  // dinners already there) and returns the created slot, which we append.
  const addDinner = useCallback(
    async (dayOfWeek: number, recipeId: string) => {
      if (!plan) return;
      const res = await fetch("/api/plan", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ weekPlanId: plan.id, dayOfWeek, recipeId }),
      });
      const slot: Slot = await res.json();
      setPlan((p) => (p ? { ...p, slots: [...p.slots, slot] } : p));
    },
    [plan],
  );

  const removeDinner = useCallback(async (slotId: string) => {
    // Optimistic: drop it from the calendar straight away.
    setPlan((p) =>
      p ? { ...p, slots: p.slots.filter((s) => s.id !== slotId) } : p,
    );
    await fetch(`/api/plan?slotId=${slotId}`, { method: "DELETE" });
  }, []);

  const updateServings = useCallback(
    async (slotId: string, servingsOverride: number | null) => {
      setPlan((p) =>
        p
          ? {
              ...p,
              slots: p.slots.map((s) =>
                s.id === slotId ? { ...s, servingsOverride } : s,
              ),
            }
          : p,
      );
      await fetch("/api/plan", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ slotId, servingsOverride }),
      });
    },
    [],
  );

  async function generate() {
    if (!plan) return;
    setGenerating(true);
    try {
      await fetch("/api/shopping", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ weekPlanId: plan.id }),
      });
      router.push("/shopping");
    } finally {
      setGenerating(false);
    }
  }

  const anyRecipeAssigned = (plan?.slots.length ?? 0) > 0;

  return (
    <div className="calendar-page">
      <div className="week-header">
        <button
          onClick={() => setWeekStart(addDays(weekStart, -7))}
          aria-label="Previous week"
        >
          ←
        </button>
        <div className="week-header-title">
          <h1>{weekLabel(weekStart)}</h1>
          <span className="muted">
            {weekStart === thisWeek
              ? "This week"
              : weekStart === addDays(thisWeek, 7)
                ? "Next week"
                : "Dinners"}
          </span>
        </div>
        <button
          onClick={() => setWeekStart(addDays(weekStart, 7))}
          aria-label="Next week"
        >
          →
        </button>
      </div>

      {weekStart !== thisWeek && (
        <p>
          <button className="muted" onClick={() => setWeekStart(thisWeek)}>
            ← Back to this week
          </button>
        </p>
      )}

      {recipes.length === 0 && (
        <p className="muted">
          Your library is empty — <Link href="/recipes/new">paste a recipe</Link>{" "}
          first.
        </p>
      )}

      <div className="calendar">
        {DAYS.map((dayName, dayOfWeek) => {
          const date = addDays(weekStart, dayOfWeek);
          const daySlots =
            plan?.slots.filter((s) => s.dayOfWeek === dayOfWeek) ?? [];

          return (
            <div
              className={`day${date === today ? " day-today" : ""}`}
              key={dayOfWeek}
            >
              <div className="day-head">
                <span className="day-name">{dayName}</span>
                <span className="day-date">{dayNumber(date)}</span>
              </div>

              <div className="day-body">
                {!plan ? (
                  <p className="muted day-empty">…</p>
                ) : daySlots.length === 0 ? (
                  <p className="muted day-empty">Leftovers / eating out</p>
                ) : (
                  daySlots.map((slot) => {
                    const recipe = slot.recipe;
                    const photo = recipe ? recipeImageSrc(recipe) : null;
                    return (
                      <div className="dinner" key={slot.id}>
                        <Link
                          href={`/recipes/${slot.recipeId}`}
                          className="day-photo"
                          tabIndex={-1}
                          aria-hidden
                        >
                          {photo ? (
                            // eslint-disable-next-line @next/next/no-img-element
                            <img src={photo} alt="" loading="lazy" />
                          ) : (
                            <span className="recipe-thumb-empty">🍽</span>
                          )}
                        </Link>
                        <button
                          className="dinner-remove"
                          onClick={() => removeDinner(slot.id)}
                          aria-label={`Remove ${recipe?.name ?? "dinner"}`}
                        >
                          ×
                        </button>
                        <Link
                          href={`/recipes/${slot.recipeId}`}
                          className="day-title"
                        >
                          {recipe?.name}
                        </Link>
                        <label className="muted day-serves">
                          serves{" "}
                          <input
                            type="number"
                            min={1}
                            placeholder="household"
                            value={slot.servingsOverride ?? ""}
                            onChange={(e) =>
                              updateServings(
                                slot.id,
                                e.target.value ? Number(e.target.value) : null,
                              )
                            }
                          />
                        </label>
                      </div>
                    );
                  })
                )}
              </div>

              {plan && (
                <select
                  className="day-picker"
                  // A pure "add" control: it never reflects a selection, so it
                  // resets to the prompt after each pick.
                  value=""
                  onChange={(e) => {
                    if (e.target.value) addDinner(dayOfWeek, e.target.value);
                  }}
                  aria-label={`Add dinner for ${dayName}`}
                >
                  <option value="">
                    {daySlots.length ? "+ Add another" : "+ Add dinner"}
                  </option>
                  {recipes.map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.name}
                    </option>
                  ))}
                </select>
              )}
            </div>
          );
        })}
      </div>

      <button onClick={generate} disabled={generating || !anyRecipeAssigned}>
        {generating ? "Generating…" : "Generate shopping list"}
      </button>
      {!anyRecipeAssigned && (
        <span className="muted" style={{ marginLeft: 8 }}>
          Assign at least one dinner first.
        </span>
      )}
    </div>
  );
}
