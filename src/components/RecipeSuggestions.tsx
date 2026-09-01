"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { formatDurationMinutes } from "@/lib/durations";
import { recipeImageSrc } from "@/lib/recipeImage";
import { isSuggestable, type RecipeKind } from "@/lib/recipeKind";
import {
  CATEGORY_FILTERS,
  categoryFilterLabel,
  categoryHint,
  type CategoryFilter,
  type RecipeCategory,
} from "@/lib/recipeCategory";
import {
  DEFAULT_SUGGESTION_COUNT,
  eligibleForSuggestion,
  suggestRecipes,
} from "@/lib/recipeSuggestions";

/**
 * "What shall we have?" — three dinners out of the library, at random (§2e).
 *
 * The dashboard's job is to be the screen you land on, and until now it landed
 * you on a count and a spending chart: true, and no help with the thing you
 * actually opened the app to decide. The library can already answer "do we
 * have a cod recipe" (§2) — this answers the question you have *before* that
 * one, which is the harder one, and the reason the same eight dinners come
 * round for years.
 *
 * A client component rather than three recipes picked on the server. The
 * shuffle has to be free — that's the whole gesture, press until something
 * appeals — and re-rendering the page for each press would be both slow and
 * a lie about what changed. It also means the draw happens after mount, so
 * there is no server/client mismatch to reconcile: a server-rendered random
 * pick is a hydration error waiting for its second render.
 *
 * The whole library arrives in one request, the same one the library page
 * makes and the service worker already caches, so shuffling costs nothing and
 * works offline over Tailscale (§10) — the same reasoning as `recipeSearch`.
 */

const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

interface Recipe {
  id: string;
  name: string;
  kind: RecipeKind;
  category: RecipeCategory | null;
  imageMime: string | null;
  imageUrl: string | null;
  totalTimeMinutes: number | null;
  totalTimeIsEstimate: boolean;
  lastCookedOn: string | null;
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

/**
 * The one line under the name, saying why this one is worth a look.
 *
 * Staleness rather than the ingredient count the library row leads with: the
 * card is arguing for a dinner, and "we haven't made this since March" is the
 * argument. A recipe that has never been cooked says so plainly — that is the
 * strongest case a suggestion can make for itself.
 */
function whyLabel(recipe: Recipe): string {
  if (!recipe.lastCookedOn) return "Never cooked";
  const weeks = Math.round(
    (Date.now() - Date.parse(recipe.lastCookedOn)) / (7 * 24 * 60 * 60 * 1000),
  );
  if (weeks <= 0) return "Cooked this week";
  if (weeks === 1) return "Cooked last week";
  if (weeks >= 52) return "Not cooked in over a year";
  return `Not cooked in ${weeks} weeks`;
}

function timeLabel(recipe: Recipe): string | null {
  if (recipe.totalTimeMinutes == null) return null;
  const time = formatDurationMinutes(recipe.totalTimeMinutes);
  return recipe.totalTimeIsEstimate ? `about ${time}` : time;
}

export function RecipeSuggestions() {
  const [recipes, setRecipes] = useState<Recipe[] | null>(null);
  const [plan, setPlan] = useState<WeekPlan | null>(null);
  const [filter, setFilter] = useState<CategoryFilter>("ANY");
  const [picks, setPicks] = useState<Recipe[]>([]);
  const [added, setAdded] = useState<Record<string, string>>({});

  useEffect(() => {
    fetch("/api/recipes")
      .then((r) => r.json())
      .then(setRecipes);
    fetch("/api/plan")
      .then((r) => r.json())
      .then(setPlan);
  }, []);

  // Ids of the dinners already on this week — not suggestions, by definition
  // (§2e).
  //
  // Held in a ref, and that is the load-bearing part. The plan is an *input*
  // to a draw but must never *trigger* one: adding a dinner from this card
  // updates the plan, and if that fed a dependency array the other two
  // suggestions would vanish the instant you took the first, which reads as
  // the card throwing away the answer you just accepted. So the draw reads
  // the plan when it draws, and redraws only when asked.
  const plannedRef = useRef<string[]>([]);
  plannedRef.current = (plan?.slots ?? []).map((s) => s.recipeId);

  const draw = useCallback(
    (avoid: string[]) => {
      setPicks(
        suggestRecipes(recipes ?? [], {
          filter,
          planned: plannedRef.current,
          avoid,
          count: DEFAULT_SUGGESTION_COUNT,
        }),
      );
    },
    [recipes, filter],
  );

  // Three things draw a fresh set, and nothing else does: the library
  // arriving, the plan first arriving (so the very first draw already knows
  // what's booked), and the category being pressed. Each is a moment where
  // the previous three stopped being an answer to what was asked, so there is
  // nothing worth avoiding — `avoid` belongs to the shuffle button alone.
  const planLoaded = plan !== null;
  useEffect(() => {
    if (recipes) draw([]);
  }, [recipes, planLoaded, draw]);

  function nextEmptyDay(): number {
    const used = new Set(plan?.slots.map((s) => s.dayOfWeek));
    for (let d = 0; d < 7; d++) if (!used.has(d)) return d;
    return 0;
  }

  async function addToPlan(recipe: Recipe) {
    if (!plan) return;
    const dayOfWeek = nextEmptyDay();
    // Said before the request comes back, and left in place rather than the
    // row vanishing: a suggestion that disappears the moment you take it
    // leaves you wondering whether it landed.
    setAdded((a) => ({ ...a, [recipe.id]: `Added to ${DAYS[dayOfWeek]} ✓` }));
    const res = await fetch("/api/plan", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ weekPlanId: plan.id, dayOfWeek, recipeId: recipe.id }),
    });
    const slot: Slot = await res.json();
    setPlan((p) => (p ? { ...p, slots: [...p.slots, slot] } : p));
  }

  /** Why the card is empty — a different sentence, and a different fix, each. */
  function emptyLine(): string {
    // Dinners, not everything plannable: a library holding nothing but salads
    // has nothing to suggest, and saying so is more use than "every dinner
    // that fits is already on the plan" about a set that is empty (§2c).
    const dinners = (recipes ?? []).filter((r) => isSuggestable(r.kind));
    if (dinners.length === 0) {
      return "Nothing to suggest yet — no dinners in the library.";
    }
    // What we'd have had to offer if the week weren't in the way. It tells
    // "nothing is marked fish" apart from "we've planned it all already",
    // which are opposite problems with opposite fixes — and it is only worth
    // computing here, on the one render where the card has nothing to show.
    if (eligibleForSuggestion(dinners, { filter }).length === 0) {
      return filter === "UNSET"
        ? "Every dinner has a category. Nothing left to file."
        : `No dinner is marked ${categoryFilterLabel(filter).toLowerCase()} yet — set it on a recipe's edit page.`;
    }
    return "Every dinner that fits is already on this week's plan.";
  }

  return (
    <div className="card">
      <div className="suggest-head">
        <h2>What shall we have?</h2>
        <button
          onClick={() => draw(picks.map((r) => r.id))}
          disabled={!recipes}
          title="Three more from the library"
        >
          Shuffle
        </button>
      </div>

      {/* The question before the recipe (§2d): fish on Monday means not fish
          tonight, and that is the filter you actually reach for. */}
      <div role="group" aria-label="Suggest by category" className="category-filters">
        {CATEGORY_FILTERS.map((f) => (
          <button
            key={f}
            className="category-filter"
            aria-pressed={f === filter}
            title={f === "ANY" || f === "UNSET" ? undefined : categoryHint(f)}
            onClick={() => setFilter(f)}
          >
            {categoryFilterLabel(f)}
          </button>
        ))}
      </div>

      {!recipes ? (
        <p className="muted">Loading…</p>
      ) : picks.length === 0 ? (
        <p className="muted">{emptyLine()}</p>
      ) : (
        <ul className="suggest-list">
          {picks.map((r) => (
            <li className="recipe-row suggest-row" key={r.id}>
              {/* Decorative: the name beside it is the real link. */}
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
                <Link href={`/recipes/${r.id}`}>
                  <strong>{r.name}</strong>
                </Link>
                <div className="muted suggest-why">
                  <span style={{ fontStyle: r.lastCookedOn ? "normal" : "italic" }}>
                    {whyLabel(r)}
                  </span>
                  {timeLabel(r) && <span>· {timeLabel(r)}</span>}
                </div>
              </div>

              {plan && (
                <div className="suggest-action">
                  {added[r.id] ? (
                    <em className="muted">{added[r.id]}</em>
                  ) : (
                    <button onClick={() => addToPlan(r)}>
                      Add to {DAYS[nextEmptyDay()]}
                    </button>
                  )}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
