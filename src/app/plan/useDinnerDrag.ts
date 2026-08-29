"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Dragging a dinner from one night to another on the plan calendar (§3).
 *
 * Pointer events rather than HTML5 drag-and-drop, which is the obvious choice
 * and the wrong one: `dragstart` never fires for touch, and this is a calendar
 * planned on a phone at the kitchen table. Pointer events are one code path for
 * finger, mouse and stylus alike, and pointer *capture* means the gesture keeps
 * reporting to the card you grabbed even when your thumb has wandered three
 * columns away — which is the entire gesture.
 *
 * What this hook does not do is decide anything about the week: it reports
 * "this dinner, over that night, at that place in its stack" and leaves the
 * arithmetic to `moveDinner` and the writing to the caller.
 *
 * Geometry is measured once, when the drag starts, and held in page
 * coordinates. Nothing about the drag changes the layout — the dragged card
 * keeps its space, and the drop indicator is drawn with an absolutely
 * positioned rule (see .dinner-drop-* in globals.css) — so a measurement taken
 * at the start is still true at the end, and re-measuring on every frame would
 * only make the target flicker as the card being dragged pushed its neighbours
 * about underneath it.
 */

/** Movement before a press becomes a drag, so a tap on the grip does nothing. */
const DRAG_THRESHOLD = 4;
/** How near the top or bottom of the window auto-scrolling starts. */
const EDGE = 76;
/** Auto-scroll speed, in px per frame, right at the edge. */
const EDGE_SPEED = 14;

/** Where a dragged dinner would land if you let go now. */
export interface DropTarget {
  /** 0 = Monday … 6 = Sunday. */
  day: number;
  /** Its place in that night's stack, counted from the top. */
  index: number;
}

interface MeasuredNight {
  day: number;
  top: number;
  bottom: number;
  left: number;
  right: number;
  /** Vertical midpoints of the dinners already on this night, in order. */
  dinners: { id: string; mid: number }[];
}

interface Press {
  pointerId: number;
  slotId: string;
  startX: number;
  startY: number;
  /** Null until the pointer has moved far enough to mean a drag. */
  nights: MeasuredNight[] | null;
}

export interface DinnerDrag {
  /** Put on the calendar grid: the drag reads the DOM through it. */
  calendarRef: React.RefObject<HTMLDivElement | null>;
  /** The dinner being dragged, or null when nothing is. */
  dragSlotId: string | null;
  /** Where it would land, or null before the press becomes a drag. */
  target: DropTarget | null;
  /** Spread onto a dinner's grip handle. */
  handleProps: (slotId: string) => {
    onPointerDown: (e: React.PointerEvent) => void;
    onPointerMove: (e: React.PointerEvent) => void;
    onPointerUp: (e: React.PointerEvent) => void;
    onPointerCancel: (e: React.PointerEvent) => void;
  };
}

/**
 * @param onDrop Called once, on release, only when the dinner would actually
 *   move. A drag that ends where it started is the commonest gesture there is —
 *   you pick a card up and think better of it — and it should cost nothing.
 */
export function useDinnerDrag(
  onDrop: (slotId: string, target: DropTarget) => void,
): DinnerDrag {
  const calendarRef = useRef<HTMLDivElement | null>(null);
  const press = useRef<Press | null>(null);
  /** The pointer, in viewport coordinates, between frames. */
  const point = useRef<{ x: number; y: number } | null>(null);
  /** The state below, readable from handlers that don't re-render. */
  const targetRef = useRef<DropTarget | null>(null);

  const [dragSlotId, setDragSlotId] = useState<string | null>(null);
  const [target, setTarget] = useState<DropTarget | null>(null);

  // Kept in a ref so the pointer handlers don't have to be rebuilt — and so a
  // drop can't call a callback captured before the week last changed.
  const drop = useRef(onDrop);
  drop.current = onDrop;

  /** Read the week's boxes out of the DOM, in page coordinates. */
  const measure = useCallback((): MeasuredNight[] => {
    const root = calendarRef.current;
    if (!root) return [];
    const sx = window.scrollX;
    const sy = window.scrollY;
    return [...root.querySelectorAll<HTMLElement>("[data-day]")].map((el) => {
      const r = el.getBoundingClientRect();
      return {
        day: Number(el.dataset.day),
        top: r.top + sy,
        bottom: r.bottom + sy,
        left: r.left + sx,
        right: r.right + sx,
        dinners: [...el.querySelectorAll<HTMLElement>("[data-slot-id]")].map(
          (card) => {
            const cr = card.getBoundingClientRect();
            return {
              id: card.dataset.slotId ?? "",
              mid: cr.top + cr.height / 2 + sy,
            };
          },
        ),
      };
    });
  }, []);

  /** Which night the pointer is over, and where in its stack. */
  const hitTest = useCallback(
    (x: number, y: number, nights: MeasuredNight[], slotId: string) => {
      const night = nights.find(
        (n) => x >= n.left && x <= n.right && y >= n.top && y <= n.bottom,
      );
      // Off the calendar entirely — in the gutter between two cards, or out in
      // the page margin. The last target stands rather than being dropped, so a
      // finger tracking diagonally across a gap doesn't make the indicator
      // blink out and back.
      if (!night) return null;
      // Counted among the *other* dinners: the dragged card still occupies its
      // old space, and `moveDinner` likewise counts a place in the stack after
      // the dinner has been lifted out of it.
      const others = night.dinners.filter((d) => d.id !== slotId);
      return {
        day: night.day,
        index: others.filter((d) => y > d.mid).length,
      };
    },
    [],
  );

  /** Recompute the target from wherever the pointer and the page now are. */
  const track = useCallback(() => {
    const p = press.current;
    const at = point.current;
    if (!p?.nights || !at) return;
    const hit = hitTest(
      at.x + window.scrollX,
      at.y + window.scrollY,
      p.nights,
      p.slotId,
    );
    if (!hit) return;
    if (
      targetRef.current?.day === hit.day &&
      targetRef.current?.index === hit.index
    ) {
      return;
    }
    targetRef.current = hit;
    setTarget(hit);
  }, [hitTest]);

  const end = useCallback((dropped: boolean) => {
    const p = press.current;
    const landing = targetRef.current;
    press.current = null;
    point.current = null;
    targetRef.current = null;
    setDragSlotId(null);
    setTarget(null);
    // Only a press that became a drag can land anywhere; a tap on the grip is
    // not a move of zero distance, it's nothing at all.
    if (dropped && p?.nights && landing) drop.current(p.slotId, landing);
  }, []);

  const handleProps = useCallback(
    (slotId: string) => ({
      onPointerDown: (e: React.PointerEvent) => {
        // Left button only; a right-click shouldn't pick a dinner up.
        if (e.pointerType === "mouse" && e.button !== 0) return;
        e.currentTarget.setPointerCapture(e.pointerId);
        press.current = {
          pointerId: e.pointerId,
          slotId,
          startX: e.clientX,
          startY: e.clientY,
          nights: null,
        };
      },
      onPointerMove: (e: React.PointerEvent) => {
        const p = press.current;
        if (!p || e.pointerId !== p.pointerId) return;
        point.current = { x: e.clientX, y: e.clientY };
        if (!p.nights) {
          if (Math.hypot(e.clientX - p.startX, e.clientY - p.startY) < DRAG_THRESHOLD) {
            return;
          }
          p.nights = measure();
          setDragSlotId(p.slotId);
        }
        track();
      },
      onPointerUp: (e: React.PointerEvent) => {
        if (press.current && e.pointerId !== press.current.pointerId) return;
        end(true);
      },
      onPointerCancel: (e: React.PointerEvent) => {
        if (press.current && e.pointerId !== press.current.pointerId) return;
        end(false);
      },
    }),
    [measure, track, end],
  );

  // Auto-scroll at the edges of the window. Without it a phone can only move a
  // dinner as far as one screenful of calendar, and the week is taller than
  // that — Monday and Sunday are never on screen together.
  //
  // A frame loop rather than more work in the move handler: a finger held still
  // at the bottom of the screen is exactly the gesture that means "keep going",
  // and it fires no pointer events at all. Each frame that scrolls re-runs the
  // hit test, since the page moved under a pointer that didn't.
  useEffect(() => {
    if (!dragSlotId) return;
    let frame = requestAnimationFrame(function step() {
      frame = requestAnimationFrame(step);
      const at = point.current;
      if (!at) return;
      const height = window.innerHeight;
      const near = (d: number) => Math.max(0, Math.min(1, 1 - d / EDGE));
      const dy =
        at.y < EDGE
          ? -EDGE_SPEED * near(at.y)
          : at.y > height - EDGE
            ? EDGE_SPEED * near(height - at.y)
            : 0;
      if (dy === 0) return;
      window.scrollBy(0, dy);
      track();
    });
    return () => cancelAnimationFrame(frame);
  }, [dragSlotId, track]);

  // Escape puts the dinner back — the way out of a gesture you've changed your
  // mind about halfway through, and the one every drag interface is expected to
  // have.
  useEffect(() => {
    if (!dragSlotId) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") end(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [dragSlotId, end]);

  return { calendarRef, dragSlotId, target, handleProps };
}
