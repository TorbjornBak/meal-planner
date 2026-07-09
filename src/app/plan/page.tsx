"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";

// Weekly dinner plan (§3, §4). Assign a recipe to any night; leave nights empty
// for leftovers / eating out. Optional per-night servings override for guests or
// batch-cooking. Then generate the shopping list (§5).

const DAYS = [
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
  "Sunday",
];

interface Slot {
  dayOfWeek: number;
  recipeId: string | null;
  servingsOverride: number | null;
}
interface WeekPlan {
  id: string;
  weekStart: string;
  slots: Slot[];
}
interface RecipeOption {
  id: string;
  name: string;
}

export default function PlanPage() {
  const router = useRouter();
  const [plan, setPlan] = useState<WeekPlan | null>(null);
  const [recipes, setRecipes] = useState<RecipeOption[]>([]);
  const [generating, setGenerating] = useState(false);

  useEffect(() => {
    // Current week (the API upserts it with 7 empty slots) + the recipe library.
    Promise.all([
      fetch("/api/plan").then((r) => r.json()),
      fetch("/api/recipes").then((r) => r.json()),
    ]).then(([p, rs]) => {
      setPlan(p);
      setRecipes(rs.map((r: RecipeOption) => ({ id: r.id, name: r.name })));
    });
  }, []);

  const updateSlot = useCallback(
    async (dayOfWeek: number, patch: Partial<Slot>) => {
      if (!plan) return;
      const current = plan.slots.find((s) => s.dayOfWeek === dayOfWeek)!;
      const next = { ...current, ...patch };

      // Optimistic local update.
      setPlan({
        ...plan,
        slots: plan.slots.map((s) => (s.dayOfWeek === dayOfWeek ? next : s)),
      });

      await fetch("/api/plan", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          weekPlanId: plan.id,
          dayOfWeek,
          recipeId: next.recipeId,
          servingsOverride: next.servingsOverride,
        }),
      });
    },
    [plan],
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

  if (!plan) return <p className="muted">Loading…</p>;

  const anyRecipeAssigned = plan.slots.some((s) => s.recipeId);

  return (
    <>
      <h1>This week&rsquo;s dinners</h1>
      <p className="muted">
        Week of {plan.weekStart.slice(0, 10)}. Assign a recipe to any night;
        leave nights empty for leftovers or eating out.
      </p>

      {recipes.length === 0 && (
        <p className="muted">
          Your library is empty — <a href="/recipes/new">paste a recipe</a> first.
        </p>
      )}

      {plan.slots
        .slice()
        .sort((a, b) => a.dayOfWeek - b.dayOfWeek)
        .map((slot) => (
          <div className="card" key={slot.dayOfWeek}>
            <strong>{DAYS[slot.dayOfWeek]}</strong>
            <div style={{ marginTop: 8, display: "flex", gap: 12, flexWrap: "wrap" }}>
              <select
                value={slot.recipeId ?? ""}
                onChange={(e) =>
                  updateSlot(slot.dayOfWeek, {
                    recipeId: e.target.value || null,
                    // Clearing the night also clears its override.
                    servingsOverride: e.target.value ? slot.servingsOverride : null,
                  })
                }
              >
                <option value="">— leftovers / eating out —</option>
                {recipes.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.name}
                  </option>
                ))}
              </select>

              {slot.recipeId && (
                <label className="muted">
                  serves{" "}
                  <input
                    type="number"
                    min={1}
                    placeholder="household"
                    value={slot.servingsOverride ?? ""}
                    onChange={(e) =>
                      updateSlot(slot.dayOfWeek, {
                        servingsOverride: e.target.value
                          ? Number(e.target.value)
                          : null,
                      })
                    }
                    style={{ width: 90 }}
                  />
                </label>
              )}
            </div>
          </div>
        ))}

      <button onClick={generate} disabled={generating || !anyRecipeAssigned}>
        {generating ? "Generating…" : "Generate shopping list"}
      </button>
      {!anyRecipeAssigned && (
        <span className="muted" style={{ marginLeft: 8 }}>
          Assign at least one dinner first.
        </span>
      )}
    </>
  );
}
