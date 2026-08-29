/**
 * Turning a night's decision into words (§3, §9b).
 *
 * A NightNote is a kind plus optional free text, and three places have to say
 * the same thing about it: the calendar cell on the plan page, the night's row
 * in the weekly digest's HTML, and that row again in the digest's plain-text
 * copy (§9b requires both halves of the mail, and they must agree). Pure, and
 * kept here rather than in any one of them, so none can drift from the others.
 */

/** Mirrors NightNoteKind in schema.prisma. */
export type NightNoteKind = "LEFTOVERS" | "OUT" | "OTHER";

export interface NightNote {
  kind: NightNoteKind;
  text?: string | null;
}

/**
 * What the household sees on a decided night.
 *
 * The kind carries the usual case in one word, and the text refines it when
 * there's something to add — "Leftovers — the lasagne from Sunday". OTHER is
 * the escape hatch, so its text stands alone; with nothing typed it still has
 * to read as a decision rather than a blank, because the whole point of a note
 * is that this night is settled.
 */
export function nightNoteLabel(note: NightNote): string {
  const detail = note.text?.trim() || null;

  switch (note.kind) {
    case "LEFTOVERS":
      return detail ? `Leftovers — ${detail}` : "Leftovers";
    case "OUT":
      return detail ? `Eating out — ${detail}` : "Eating out";
    case "OTHER":
      return detail ?? "No dinner needed";
  }
}
