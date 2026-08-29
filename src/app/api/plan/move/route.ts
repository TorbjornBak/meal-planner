import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { moveDinner } from "@/lib/planMove";

/**
 * Move a dinner to another night (§3).
 *
 * Reshuffling is what a household actually does to a plan: Thursday's stew is
 * now Saturday's because of a late meeting, the two Sunday dishes want swapping.
 * Until now the only way to say that was to delete the dinner and add it again
 * on the other night — which loses its servings override (§4) silently, and
 * costs two taps and a search through the picker for a recipe already on the
 * week.
 *
 * Why a sub-route, following copy/ and note/: PATCH /api/plan means one settled
 * thing, "this dinner now serves six". A move is a different subject (where a
 * dinner sits in the week, not what it is), a different cardinality — taking a
 * dinner off a night renumbers what's left, and dropping it on another
 * renumbers that one too — and it cannot be expressed by writing one row.
 *
 * No schema change: `dayOfWeek` and `position` already say everything a move
 * changes.
 */

const MoveInput = z.object({
  slotId: z.string().min(1),
  /** The night it's being dropped on. 0 = Monday … 6 = Sunday. */
  dayOfWeek: z.number().int().min(0).max(6),
  /**
   * Where in that night's stack it lands, counted from the top *after* the
   * dinner has been lifted out of wherever it was. Not the `position` column:
   * the caller is a finger somewhere over a column of cards and knows nothing
   * about the numbers stored underneath. Anything past the end means last —
   * see moveDinner, which clamps rather than rejects.
   */
  position: z.number().int().min(0),
});

// POST /api/plan/move — put a dinner on a different night, or higher up the one
// it's already on.
export async function POST(req: Request) {
  const parsed = MoveInput.safeParse(await req.json());
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }
  const { slotId, dayOfWeek, position } = parsed.data;

  // The week comes from the dinner rather than from the caller. A slot belongs
  // to exactly one week, so asking for it would only create a way to be wrong —
  // and the honest answer for a dinner someone else has since removed is 404,
  // not a move into a week it was never on.
  const moving = await prisma.dinnerSlot.findUnique({
    where: { id: slotId },
    select: { weekPlanId: true },
  });
  if (!moving) {
    return NextResponse.json({ error: "dinner not found" }, { status: 404 });
  }

  const before = await prisma.dinnerSlot.findMany({
    where: { weekPlanId: moving.weekPlanId },
    select: { id: true, dayOfWeek: true, position: true },
    orderBy: [{ dayOfWeek: "asc" }, { position: "asc" }],
  });
  const after = moveDinner(before, slotId, dayOfWeek, position);

  // Only the rows that actually changed. Two nights out of seven are involved
  // in any move, and usually a handful of rows within them; writing the other
  // five nights back unchanged would be a fistful of pointless updates and
  // would stamp over a dinner another phone added to them a moment ago.
  const was = new Map(before.map((s) => [s.id, s]));
  const changed = after.filter((s) => {
    const previous = was.get(s.id);
    return (
      previous &&
      (previous.dayOfWeek !== s.dayOfWeek || previous.position !== s.position)
    );
  });

  // One transaction, so a week can't be left with the dinner lifted off one
  // night and never landed on the other. There's no unique constraint on
  // (week, day, position) to trip over mid-way — positions only have to sort —
  // which is why plain updates in any order are safe here.
  if (changed.length > 0) {
    await prisma.$transaction(
      changed.map((s) =>
        prisma.dinnerSlot.update({
          where: { id: s.id },
          data: { dayOfWeek: s.dayOfWeek, position: s.position },
        }),
      ),
    );
  }

  // The whole week's ordering, positions and all — the page dragged the card
  // into place optimistically and this is what it reconciles against. Ids only:
  // nothing about a dinner *except* where it sits can change here, and the page
  // is already holding the recipes.
  return NextResponse.json({ slots: after });
}
