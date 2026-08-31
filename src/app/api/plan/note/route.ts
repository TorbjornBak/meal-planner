import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { currentHouseholdContext } from "@/lib/currentUser";

/**
 * Marking a night as decided rather than merely empty (§3, §9b).
 *
 * §3 says a night can be left empty — leftovers, or eating out — and means it.
 * What the plan could never say was whether an empty night was that decision or
 * simply one nobody had got to, so the weekly digest counted both and nagged
 * "Fill in the 4 empty nights" at a household whose Wednesday is leftovers by
 * standing arrangement. A note is the household answering that question once.
 *
 * Why a sub-route, like copy/: POST /api/plan means one settled thing, "add
 * this dinner to this night". A note is a different subject (the night itself,
 * not what's cooking on it) with a different cardinality (one per night, not a
 * stack), and folding it into /api/plan would need a discriminated-union body
 * and a handler that starts by asking which request it got. /api/plan/copy
 * already set this precedent today; /api/shopping/items set it before that.
 *
 * POST rather than PUT, even though setting a note twice is idempotent: no
 * route in this app speaks PUT, and one endpoint quietly using a fourth verb
 * costs a reader more than the shade of meaning is worth. The upsert below is
 * where the idempotence actually lives.
 */

const NoteInput = z.object({
  weekPlanId: z.string().min(1),
  dayOfWeek: z.number().int().min(0).max(6),
  /**
   * Mirrors the NightNoteKind enum in schema.prisma. Written out rather than
   * derived from the generated client so a bad body is rejected by zod with the
   * same shape of error as every other route here, instead of by Postgres.
   */
  kind: z.enum(["LEFTOVERS", "OUT", "OTHER"]),
  /**
   * The optional "why" — "Mormors fødselsdag", "lasagne from Sunday". Trimmed
   * to null so a cleared text box and an untouched one store the same thing;
   * capped because this is a calendar cell, not a diary.
   */
  text: z
    .string()
    .trim()
    .max(200)
    .nullish()
    .transform((t) => t || null),
});

// POST /api/plan/note — set (or change) a night's note.
export async function POST(req: Request) {
  const context = await currentHouseholdContext();
  if (!context) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const parsed = NoteInput.safeParse(await req.json());
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }
  const { weekPlanId, dayOfWeek, kind, text } = parsed.data;

  const plan = await prisma.weekPlan.findFirst({
    where: { id: weekPlanId, householdId: context.household.id },
    select: { id: true },
  });
  if (!plan) return NextResponse.json({ error: "not found" }, { status: 404 });

  // Upsert on the (weekPlanId, dayOfWeek) unique index: a night holds one
  // decision, so tapping "Eating out" on a night already marked "Leftovers" is
  // changing your mind, not adding a second note. Doing it in one statement
  // also means two phones deciding at once can't race into a constraint error.
  const note = await prisma.nightNote.upsert({
    where: { weekPlanId_dayOfWeek: { weekPlanId, dayOfWeek } },
    update: { kind, text },
    create: { weekPlanId, dayOfWeek, kind, text },
  });

  return NextResponse.json(note);
}

// DELETE /api/plan/note?weekPlanId=...&dayOfWeek=... — the night goes back to
// undecided, which is what the digest counts.
export async function DELETE(req: Request) {
  const context = await currentHouseholdContext();
  if (!context) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const params = new URL(req.url).searchParams;
  const weekPlanId = params.get("weekPlanId");
  const dayOfWeek = Number(params.get("dayOfWeek"));

  if (!weekPlanId || !Number.isInteger(dayOfWeek) || dayOfWeek < 0 || dayOfWeek > 6) {
    return NextResponse.json(
      { error: "weekPlanId and dayOfWeek (0–6) required" },
      { status: 400 },
    );
  }

  const plan = await prisma.weekPlan.findFirst({
    where: { id: weekPlanId, householdId: context.household.id },
    select: { id: true },
  });
  if (!plan) return NextResponse.json({ error: "not found" }, { status: 404 });

  // deleteMany, not delete: clearing a night that was already clear is the
  // outcome the caller asked for, not a 404 for the page to handle. (A double
  // tap, or the other phone getting there first.)
  await prisma.nightNote.deleteMany({ where: { weekPlanId, dayOfWeek } });
  return NextResponse.json({ ok: true });
}
