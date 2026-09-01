import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { mondayOf } from "../week";
import { currentHouseholdContext } from "@/lib/currentUser";

/**
 * Copy a previous week's dinners into an open week (§3).
 *
 * Households eat on a rotation — the same fifteen or so dinners come round
 * again — but until now the only way to fill a week was one dinner at a time
 * through POST /api/plan, so every Sunday meant retyping last Sunday. That
 * re-entry is the friction that gets a planning app quietly abandoned, and it
 * is friction the data model doesn't need: last week's slots already say what
 * the household eats.
 *
 * Why a sub-route rather than another verb on /api/plan:
 *   - POST /api/plan already means one thing, "add this dinner to this night".
 *     Copying is a different subject (a whole week), a different cardinality
 *     (many slots), and a different source of truth for the fields (another
 *     week's rows, not the caller's). Overloading POST would mean a
 *     discriminated-union body and a handler that starts by asking which
 *     request it got — the endpoint would no longer mean anything on its own.
 *   - /api/shopping/items sits beside /api/shopping for exactly this reason,
 *     and its own comment says so; this follows the precedent rather than
 *     inventing a second convention.
 *
 * No schema change: DinnerSlot already carries everything a copy needs, and a
 * copied dinner is an ordinary dinner — nothing here records where it came
 * from, because nothing would read it.
 *
 * Night notes (§3, §9b) come across too — see the note block further down.
 */

const CopyInput = z.object({
  /** The week being filled — the plan the page currently has open. */
  weekPlanId: z.string().min(1),
  /**
   * The week to copy from, as the `YYYY-MM-DD` week key GET /api/plan speaks.
   * A week key, not a plan id: the caller is paging through a calendar and
   * knows dates, and a week it has never opened has no id to name it by.
   */
  copyFromWeekStart: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});

// POST /api/plan/copy — recreate another week's dinners on this one.
export async function POST(req: Request) {
  const context = await currentHouseholdContext();
  if (!context) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const householdId = context.household.id;
  const parsed = CopyInput.safeParse(await req.json());
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }
  const { weekPlanId, copyFromWeekStart } = parsed.data;

  // Snapped to a Monday like every other week key (§3), so a caller that hands
  // us a Wednesday copies the week that Wednesday is in rather than missing.
  // The regex above admits shapes that aren't dates ("2026-13-45"), so the
  // result still has to be checked.
  const sourceWeekStart = mondayOf(new Date(`${copyFromWeekStart}T00:00:00Z`));
  if (Number.isNaN(sourceWeekStart.getTime())) {
    return NextResponse.json(
      { error: "copyFromWeekStart is not a real date" },
      { status: 400 },
    );
  }

  const target = await prisma.weekPlan.findFirst({
    where: { id: weekPlanId, householdId },
  });
  if (!target) {
    return NextResponse.json({ error: "week plan not found" }, { status: 404 });
  }

  // Copying a week onto itself doubles every night, which nobody has ever
  // meant to ask for; it can only come from an off-by-one in a caller.
  if (target.weekStart.getTime() === sourceWeekStart.getTime()) {
    return NextResponse.json(
      { error: "that's the week you're copying into" },
      { status: 400 },
    );
  }

  const source = await prisma.weekPlan.findUnique({
    where: { householdId_weekStart: { householdId, weekStart: sourceWeekStart } },
    include: {
      slots: { orderBy: [{ dayOfWeek: "asc" }, { position: "asc" }] },
      nightNotes: true,
    },
  });
  // A week nobody ever opened has no row, and a week somebody opened and left
  // empty has no slots. Neither is an error — you asked to copy nothing and we
  // copied nothing — so both fall through to a `copied: 0` answer the page can
  // put into words instead of a failure it has to apologise for.
  const sourceSlots = source?.slots ?? [];

  // Dinners whose recipe has since been deleted from the library are skipped
  // rather than allowed to fail the copy. In the ordinary case there are none:
  // the schema cascades a recipe delete into its slots, so an orphan slot
  // can't be read here. But reading the source week and writing the target one
  // are two statements, and a delete landing between them would otherwise
  // bounce the whole copy off a foreign key — losing six good dinners over one
  // recipe somebody tidied away mid-click. Confirming the ids we're about to
  // write costs one indexed query.
  const recipeIds = [...new Set(sourceSlots.map((s) => s.recipeId))];
  const liveRecipes = recipeIds.length
      ? await prisma.recipe.findMany({
        where: { id: { in: recipeIds }, householdId },
        select: { id: true },
      })
    : [];
  const liveIds = new Set(liveRecipes.map((r) => r.id));
  const copyable = sourceSlots.filter((s) => liveIds.has(s.recipeId));

  // What happens when the target week already has dinners: we **append**. Not
  // replace, and not refuse.
  //   - Replacing would delete a half-planned week — a destructive act with no
  //     undo, on the strength of one tap.
  //   - Refusing sounds safe, but it makes the feature useless in the case it
  //     is most wanted: three nights planned, four to go.
  // Appending is the only outcome the household can walk back by hand, one ×
  // per dinner. The doubling-up risk is real, so the page asks for
  // confirmation before copying into a week that isn't empty (§3) — the guard
  // belongs where the human is, not in a 409 the page would have to work
  // around anyway.
  const existing = await prisma.dinnerSlot.findMany({
    where: { weekPlanId },
    select: { dayOfWeek: true },
  });
  const alreadyOnNight = new Map<number, number>();
  for (const s of existing) {
    alreadyOnNight.set(s.dayOfWeek, (alreadyOnNight.get(s.dayOfWeek) ?? 0) + 1);
  }

  const data = copyable.map((slot) => ({
    householdId,
    weekPlanId,
    dayOfWeek: slot.dayOfWeek,
    recipeId: slot.recipeId,
    // The guest-night / batch-cook override travels with the dinner (§4): if
    // last Saturday was six because the neighbours came, this Saturday is the
    // same dinner for the same six until someone says otherwise.
    servingsOverride: slot.servingsOverride,
    // Position is preserved as *order within the night*, offset past whatever
    // is already there. Into an empty week that offset is zero and the source
    // positions come across exactly; into a week with dinners on it the copied
    // ones land after the household's own, which is the order they were added
    // in and so the order they expect to read.
    position: slot.position + (alreadyOnNight.get(slot.dayOfWeek) ?? 0),
  }));

  // One statement, so the copy is all-or-nothing without a transaction around
  // it: a week can't end up half-filled.
  const created = data.length
    ? await prisma.dinnerSlot.createMany({ data })
    : { count: 0 };

  // Night notes travel with the week (§3, §9b). "We eat leftovers on
  // Wednesdays" is a standing arrangement in exactly the way "we eat
  // frikadeller on Mondays" is — it is part of the rotation this button exists
  // to stop retyping — and copying the dinners without the notes would hand the
  // household a week that looks four nights emptier than last week's, which is
  // the nag the notes were added to stop.
  //
  // The free text comes with the kind rather than being dropped as one-off
  // detail, on the same reasoning the servings override above travels: a copy
  // reproduces last week and the household edits what's changed. Being told
  // "Leftovers — the lasagne from Sunday" on a week where there is no lasagne
  // is a wrong sentence you can see and clear in one tap; silently thinning the
  // note down to "Leftovers" is a change you can't see at all.
  //
  // skipDuplicates, so a night this week has already decided for itself wins
  // over last week's decision. There is no appending to fall back on here the
  // way there is for dinners — a night holds one note — so the choice is
  // overwrite or keep, and overwriting would destroy something the household
  // typed on the week they're looking at.
  const noteData = (source?.nightNotes ?? []).map((note) => ({
    weekPlanId,
    dayOfWeek: note.dayOfWeek,
    kind: note.kind,
    text: note.text,
  }));
  const createdNotes = noteData.length
    ? await prisma.nightNote.createMany({ data: noteData, skipDuplicates: true })
    : { count: 0 };

  // 200, not 201: there's no single created resource to point a Location at,
  // and a copy that found nothing to copy is still a successful request. The
  // counts are what the page reports back to the household; it refetches the
  // week for the dinners themselves, since the server decides their ids,
  // positions and which of them survived the recipe check.
  return NextResponse.json({
    copied: created.count,
    skipped: sourceSlots.length - copyable.length,
    // Counted separately from the dinners because it reads differently in the
    // page's summary — "5 dinners and 2 nights off" — and because a week that
    // copied nothing but notes still copied something.
    notesCopied: createdNotes.count,
    copiedFrom: sourceWeekStart.toISOString().slice(0, 10),
  });
}
