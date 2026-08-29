"use client";

import {
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { recipeImageSrc } from "@/lib/recipeImage";
import { nightNoteLabel, type NightNote } from "@/lib/nightNotes";
import { searchRecipes } from "@/lib/recipeSearch";

// Weekly dinner plan (§3, §4), laid out as a calendar week. Assign one or more
// recipes to any night; leave nights empty for leftovers / eating out. Optional
// per-dinner servings override for guests or batch-cooking. Then generate the
// shopping list (§5).
//
// You can page backwards and forwards through weeks: the plan API upserts
// whichever week you ask for, so next week exists the moment you look at it.
//
// Dinners are added through one searchable dialog shared by all seven nights,
// not a <select> per night: see the picker section below.

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
/** A night the household settled without cooking (§3) — see /api/plan/note. */
interface PlanNightNote extends NightNote {
  dayOfWeek: number;
}
interface WeekPlan {
  id: string;
  weekStart: string;
  slots: Slot[];
  nightNotes: PlanNightNote[];
}
interface RecipeOption {
  id: string;
  name: string;
  imageMime: string | null;
  imageUrl: string | null;
  /**
   * Names only, and only so the picker can search on them (§2).
   * `GET /api/recipes` already sends these, so wanting them costs no request.
   */
  ingredients: { name: string }[];
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

function PlanCalendar() {
  const router = useRouter();
  const params = useSearchParams();
  // Both read off the *local* calendar — "today" is the day you're living in,
  // even in the hours where that differs from UTC.
  const thisWeek = useMemo(() => mondayKey(new Date()), []);
  const today = useMemo(() => {
    const d = new Date();
    return new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()))
      .toISOString()
      .slice(0, 10);
  }, []);

  // ?weekStart=YYYY-MM-DD opens a specific week, so the weekly digest (§9b)
  // can link at the week it's actually about rather than always at today's.
  // Snapped to a Monday, since every other week here is one.
  const initialWeek = useMemo(() => {
    const raw = params.get("weekStart");
    if (!raw || !/^\d{4}-\d{2}-\d{2}$/.test(raw)) return thisWeek;
    const d = new Date(`${raw}T00:00:00Z`);
    if (Number.isNaN(d.getTime())) return thisWeek;
    // Snapped in UTC, not via mondayKey: the value came in as a UTC date, and
    // reading local calendar fields off it lands a day early west of Greenwich.
    const monday = new Date(d.getTime() - ((d.getUTCDay() + 6) % 7) * 86_400_000);
    return monday.toISOString().slice(0, 10);
  }, [params, thisWeek]);

  const [weekStart, setWeekStart] = useState(initialWeek);
  const [plan, setPlan] = useState<WeekPlan | null>(null);
  const [recipes, setRecipes] = useState<RecipeOption[]>([]);
  const [generating, setGenerating] = useState(false);
  // Copying last week's dinners in (§3) — see copyLastWeek below. The note is
  // what the copy turned out to be: how many dinners came across, and whether
  // any were dropped because their recipe is gone.
  const [copying, setCopying] = useState(false);
  const [copyNote, setCopyNote] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/recipes")
      .then((r) => r.json())
      .then(setRecipes);
  }, []);

  useEffect(() => {
    let stale = false;
    // Cleared first: paging to another week shouldn't leave the old week's
    // dinners on screen looking like they belong to the new one. Nor its copy
    // note, which is a sentence about a week you're no longer looking at.
    setPlan(null);
    setCopyNote(null);
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

  // Marking a night as settled (§3, §9b). Not optimistic: the row is upserted
  // server-side, and a note that appeared locally but never landed would leave
  // the household believing a night was decided while the digest still nagged
  // about it — the one confusion this feature exists to end.
  const setNote = useCallback(
    async (dayOfWeek: number, kind: NightNote["kind"]) => {
      if (!plan) return;
      const res = await fetch("/api/plan/note", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ weekPlanId: plan.id, dayOfWeek, kind }),
      });
      if (!res.ok) return;
      const note: PlanNightNote = await res.json();
      setPlan((p) =>
        p
          ? {
              ...p,
              // Replaced rather than appended: a night holds one decision, and
              // the server upserts on exactly that.
              nightNotes: [
                ...(p.nightNotes ?? []).filter((n) => n.dayOfWeek !== dayOfWeek),
                note,
              ],
            }
          : p,
      );
    },
    [plan],
  );

  // Clearing is optimistic, unlike setting: the worst case is a night that
  // looks undecided for a moment and comes back settled on the next read.
  const clearNote = useCallback(
    async (dayOfWeek: number) => {
      if (!plan) return;
      setPlan((p) =>
        p
          ? { ...p, nightNotes: (p.nightNotes ?? []).filter((n) => n.dayOfWeek !== dayOfWeek) }
          : p,
      );
      await fetch(
        `/api/plan/note?weekPlanId=${plan.id}&dayOfWeek=${dayOfWeek}`,
        { method: "DELETE" },
      );
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

  // Fill this week from the week before it (§3). Households eat on a rotation,
  // and rebuilding the same seven nights by hand every Sunday is the friction
  // that gets a planner abandoned.
  //
  // "Last week" means the week before the one you have *open*, not the week
  // before today: the calendar pages, and planning next week off this one is
  // the case this exists for.
  const copyLastWeek = useCallback(async () => {
    if (!plan || copying) return;
    const from = addDays(weekStart, -7);

    // The copy appends rather than replaces — deliberately, so it can never
    // wipe a half-planned week (see api/plan/copy). The cost of that choice is
    // that copying into a week with dinners on it doubles them up, so ask
    // before doing it. An empty week has nothing to lose and goes straight
    // through: that's the tap this control is for.
    if (
      plan.slots.length > 0 &&
      !window.confirm(
        `${weekLabel(weekStart)} already has dinners. Add ${weekLabel(from)}'s on top of them?`,
      )
    ) {
      return;
    }

    setCopying(true);
    setCopyNote(null);
    try {
      const res = await fetch("/api/plan/copy", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ weekPlanId: plan.id, copyFromWeekStart: from }),
      });
      if (!res.ok) {
        setCopyNote("Couldn't copy that week — nothing was changed.");
        return;
      }
      const { copied, skipped } = (await res.json()) as {
        copied: number;
        skipped: number;
      };

      // Refetched, not folded into state the way addDinner does with its one
      // returned slot: a copy creates several dinners at once and the server
      // decides all of it — their ids, their positions on a night that may
      // already be occupied, and which of them survived the recipe check. The
      // week is refetched even when nothing was copied, since the answer tells
      // us the source week was empty, not what this one holds.
      const fresh: WeekPlan = await fetch(
        `/api/plan?weekStart=${weekStart}`,
      ).then((r) => r.json());
      // Only if it's still the week on screen: paging away mid-copy already
      // loaded another week, and this response would stamp over it.
      setPlan((p) => (p && p.id === fresh.id ? fresh : p));

      setCopyNote(
        copied === 0
          ? `Nothing to copy — ${weekLabel(from)} had no dinners.`
          : `Copied ${copied} dinner${copied === 1 ? "" : "s"} from ${weekLabel(from)}.` +
            (skipped > 0
              ? ` ${skipped} skipped — ${skipped === 1 ? "that recipe is" : "those recipes are"} no longer in the library.`
              : ""),
      );
    } finally {
      setCopying(false);
    }
  }, [plan, copying, weekStart]);

  // --- The recipe picker ---------------------------------------------------
  //
  // One dialog for the whole week, rather than a <select> per night. Seven
  // copies of the library is a lot of markup to carry around, none of it
  // searchable, and hunting one dinner among a hundred through a native scroll
  // wheel on a phone is miserable. `pickerDay` doubles as "is it open" and
  // "which night is it adding to".
  const [pickerDay, setPickerDay] = useState<number | null>(null);
  const [query, setQuery] = useState("");
  const [highlight, setHighlight] = useState(0);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

  // Filtered here in the browser: every recipe's ingredients arrived with the
  // library, so searching costs no request per keystroke and keeps working
  // offline over Tailscale (§10).
  const results = useMemo(() => searchRecipes(recipes, query), [recipes, query]);

  function openPicker(dayOfWeek: number) {
    setQuery("");
    setHighlight(0);
    setPickerDay(dayOfWeek);
  }

  // showModal() is what makes it modal — the backdrop, the focus trap and
  // Escape are all the browser's. Driving it from an effect rather than
  // rendering `open` keeps React the single source of truth for whether the
  // picker is up.
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (pickerDay === null) {
      if (dialog.open) dialog.close();
      return;
    }
    if (!dialog.open) dialog.showModal();
    // showModal() places focus itself, so take it back afterwards: typing
    // should land in the search box without a tap.
    inputRef.current?.focus();
  }, [pickerDay]);

  // Keep the highlighted row on screen when the arrow keys walk off the edge.
  useEffect(() => {
    listRef.current?.children[highlight]?.scrollIntoView({ block: "nearest" });
  }, [highlight]);

  const pick = useCallback(
    (recipeId: string) => {
      if (pickerDay === null) return;
      // Not awaited: the dialog should shut on the tap, and addDinner already
      // folds the created slot into the calendar when the server answers.
      void addDinner(pickerDay, recipeId);
      setPickerDay(null);
    },
    [pickerDay, addDinner],
  );

  function onPickerKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      // Wraps, so holding one arrow gets you round the list either way.
      e.preventDefault();
      if (results.length === 0) return;
      const step = e.key === "ArrowDown" ? 1 : -1;
      setHighlight((h) => (h + step + results.length) % results.length);
    } else if (e.key === "Enter") {
      e.preventDefault();
      const chosen = results[highlight];
      if (chosen) pick(chosen.recipe.id);
    } else if (e.key === "Escape") {
      // Handled here as well as natively: a search input with text in it eats
      // the first Escape in some browsers, and one press should always close.
      e.preventDefault();
      setPickerDay(null);
    }
  }

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

      {/*
        The week's own actions, straight under the header: both of these are
        about the week as a whole rather than any one night. A row of its own
        rather than more children in .week-header, which is a three-part
        ←/title/→ flex — hanging a wide button off one end pulls the date off
        centre.
      */}
      <div className="week-actions">
        {weekStart !== thisWeek && (
          <button className="muted" onClick={() => setWeekStart(thisWeek)}>
            ← Back to this week
          </button>
        )}
        {/* Offered on any week, not only an empty one: a week you've started
            is exactly where you notice you're rebuilding last week by hand.
            The confirm in copyLastWeek is what keeps that safe. */}
        {plan && (
          <button onClick={copyLastWeek} disabled={copying}>
            {copying ? "Copying…" : "Copy last week"}
          </button>
        )}
        {copyNote && <span className="muted">{copyNote}</span>}
      </div>

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
          const dayNote = (plan?.nightNotes ?? []).find(
            (n) => n.dayOfWeek === dayOfWeek,
          );

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
                ) : daySlots.length === 0 && !dayNote ? (
                  // Honest about being a gap. This used to read "Leftovers /
                  // eating out", which described the decision and the gap
                  // identically — the ambiguity notes exist to remove.
                  <p className="muted day-empty">Nothing planned yet</p>
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

                {dayNote && (
                  <p className="day-note">
                    <span>{nightNoteLabel(dayNote)}</span>
                    <button
                      className="day-note-clear"
                      onClick={() => clearNote(dayOfWeek)}
                      aria-label={`${dayName} isn't settled after all`}
                      title="Back to undecided"
                    >
                      ×
                    </button>
                  </p>
                )}
              </div>

              {/* Offered only on a night with nothing on it and nothing said:
                  a night already cooking doesn't need marking as leftovers,
                  and a settled one is changed by clearing it first. */}
              {plan && daySlots.length === 0 && !dayNote && (
                <div className="day-decide">
                  <button onClick={() => setNote(dayOfWeek, "LEFTOVERS")}>
                    Leftovers
                  </button>
                  <button onClick={() => setNote(dayOfWeek, "OUT")}>
                    Eating out
                  </button>
                </div>
              )}

              {plan && (
                <button
                  className="day-add"
                  onClick={() => openPicker(dayOfWeek)}
                  // Nothing to pick from yet; the note above the calendar says
                  // where to go instead.
                  disabled={recipes.length === 0}
                  aria-label={`Add dinner for ${dayName}`}
                >
                  {daySlots.length ? "+ Add another" : "+ Add dinner"}
                </button>
              )}
            </div>
          );
        })}
      </div>

      {/*
        The picker. Its contents only exist while it's open, which is what
        resets the query between nights and what lets the input be focused on
        mount. It's a combobox over a listbox: focus stays in the text field
        and the highlight moves under it, so typing and arrowing don't fight.
      */}
      <dialog
        ref={dialogRef}
        className="picker-dialog"
        // Fires for the browser's own Escape as well as our close() calls, so
        // React's idea of "open" can't drift from the DOM's.
        onClose={() => setPickerDay(null)}
        onClick={(e) => {
          // A click on the backdrop lands on the <dialog> element itself. The
          // body below fills it edge to edge, so nothing inside the picker can
          // be mistaken for the backdrop — the usual tap-outside-to-dismiss.
          if (e.target === dialogRef.current) setPickerDay(null);
        }}
      >
        {pickerDay !== null && (
          <div className="picker-body">
            <div className="picker-head">
              <h2 className="picker-title">
                Add dinner — {DAYS[pickerDay]}{" "}
                {dayNumber(addDays(weekStart, pickerDay))}
              </h2>
              <button
                className="muted"
                onClick={() => setPickerDay(null)}
                aria-label="Close"
              >
                ×
              </button>
            </div>

            <input
              ref={inputRef}
              className="picker-input"
              type="search"
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                // The old highlight means nothing against a new result list.
                setHighlight(0);
              }}
              onKeyDown={onPickerKeyDown}
              placeholder="Search by name or ingredient…"
              role="combobox"
              aria-expanded={true}
              aria-controls="picker-results"
              aria-autocomplete="list"
              aria-activedescendant={
                results[highlight] ? `picker-option-${highlight}` : undefined
              }
            />

            {results.length === 0 ? (
              <p className="muted picker-empty">
                No recipe matches “{query.trim()}”.
              </p>
            ) : (
              <ul
                ref={listRef}
                id="picker-results"
                className="picker-results"
                role="listbox"
                aria-label="Recipes"
              >
                {results.map((match, i) => (
                  <li
                    key={match.recipe.id}
                    id={`picker-option-${i}`}
                    role="option"
                    aria-selected={i === highlight}
                    className={`picker-option${
                      i === highlight ? " picker-option-on" : ""
                    }`}
                    // mousemove rather than mouseenter: after an arrow-key
                    // press the pointer may already be sitting over a row, and
                    // only actual movement should take the highlight back.
                    onMouseMove={() => setHighlight(i)}
                    onClick={() => pick(match.recipe.id)}
                  >
                    <span className="picker-option-name">
                      {match.recipe.name}
                    </span>
                    {/* Why this one turned up, when the name doesn't say. */}
                    {match.matchedIngredients.length > 0 && (
                      <span className="muted picker-why">
                        {match.matchedIngredients.join(" · ")}
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </dialog>

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

export default function PlanPage() {
  // useSearchParams needs a Suspense boundary to keep the page prerenderable.
  return (
    <Suspense fallback={null}>
      <PlanCalendar />
    </Suspense>
  );
}
