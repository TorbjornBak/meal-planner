/**
 * Moving a dinner from one night to another (§3).
 *
 * The calendar is a week of stacks: a night holds any number of dinners, and
 * `position` orders them within it. Reshuffling — Wednesday's fish is now
 * Friday's, the two Saturday dishes want swapping — is therefore never a change
 * to one row. Taking a dinner off Wednesday closes the gap it leaves behind,
 * and dropping it into Friday pushes everything below it down one.
 *
 * That arithmetic is the whole of this module, kept pure and away from both the
 * API route that writes the rows and the page that drags the card, because both
 * of them have to agree on it: the page renumbers optimistically so the card
 * lands where the finger let go, and the server renumbers again from the rows
 * it actually holds. If the two ever disagreed, a dinner would jump on the next
 * refresh — so they run the same function on the same input.
 */

/** The columns of a dinner slot this arithmetic actually reads. */
export interface PositionedSlot {
  id: string;
  /** 0 = Monday … 6 = Sunday. */
  dayOfWeek: number;
  /** Orders the dinners within a single night. */
  position: number;
}

/** Ordered the way the calendar reads a week: night by night, then top to bottom. */
function byDayThenPosition<T extends PositionedSlot>(slots: readonly T[]): T[] {
  return [...slots].sort(
    (a, b) => a.dayOfWeek - b.dayOfWeek || a.position - b.position,
  );
}

/**
 * The week as it looks once `slotId` has been dropped onto `toDay` as its
 * `toIndex`-th dinner.
 *
 * `toIndex` is a place in the target night's stack *after* the dinner has been
 * lifted out of wherever it was — 0 puts it on top, and anything at or past the
 * end puts it last, so a drop below the final card doesn't have to be reported
 * precisely to mean "at the bottom". Out-of-range indexes are clamped rather
 * than rejected: they come from a pointer position, and a finger just off the
 * edge of a card means the nearest sensible thing, not an error.
 *
 * Positions are renumbered densely (0, 1, 2 …) on the two nights involved, and
 * left alone everywhere else — the rows the move didn't touch shouldn't turn up
 * in the update that follows. The result comes back sorted the way GET
 * /api/plan sorts, so a page that renders `slots.filter(day)` in array order
 * shows the same week either way.
 *
 * An unknown `slotId` returns the week unchanged: the only way to ask for one
 * is to have dragged a card that someone else has since deleted, and losing the
 * gesture is better than failing the page.
 */
export function moveDinner<T extends PositionedSlot>(
  slots: readonly T[],
  slotId: string,
  toDay: number,
  toIndex: number,
): T[] {
  const ordered = byDayThenPosition(slots);
  const moving = ordered.find((s) => s.id === slotId);
  if (!moving) return ordered;

  const target = ordered.filter((s) => s.dayOfWeek === toDay && s.id !== slotId);
  const index = Math.max(0, Math.min(Math.trunc(toIndex), target.length));
  target.splice(index, 0, moving);

  // Only when it's a different night: for a move within one night the line
  // above has already produced the whole stack, and filtering again would come
  // back with the same list minus the card we just placed.
  const source =
    moving.dayOfWeek === toDay
      ? []
      : ordered.filter((s) => s.dayOfWeek === moving.dayOfWeek && s.id !== slotId);

  const renumbered = new Map<string, PositionedSlot>();
  for (const [position, slot] of target.entries()) {
    renumbered.set(slot.id, { ...slot, dayOfWeek: toDay, position });
  }
  for (const [position, slot] of source.entries()) {
    renumbered.set(slot.id, { ...slot, dayOfWeek: slot.dayOfWeek, position });
  }

  return byDayThenPosition(
    ordered.map((slot) => {
      const moved = renumbered.get(slot.id);
      return moved ? ({ ...slot, ...moved } as T) : slot;
    }),
  );
}

/**
 * Where a dinner sits now, as the pair `moveDinner` takes — so a caller can ask
 * whether a drop would actually change anything before writing it down.
 *
 * A drag that ends where it started is the commonest gesture of all: you pick a
 * card up, think better of it, and let go. That shouldn't cost a request, and
 * it certainly shouldn't renumber a night.
 */
export function dinnerPlace(
  slots: readonly PositionedSlot[],
  slotId: string,
): { day: number; index: number } | null {
  const slot = slots.find((s) => s.id === slotId);
  if (!slot) return null;
  const night = byDayThenPosition(
    slots.filter((s) => s.dayOfWeek === slot.dayOfWeek),
  );
  return {
    day: slot.dayOfWeek,
    index: night.findIndex((s) => s.id === slotId),
  };
}
