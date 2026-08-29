// Tests for the night-note wording (§3, §9b). Run with `npm test`.
//
// The label is the one string the plan page, the digest's HTML and the digest's
// plain text all read from, so what it says here is what the household reads in
// three places.

import test from "node:test";
import assert from "node:assert/strict";

import { nightNoteLabel } from "./nightNotes.ts";

test("a kind alone reads as a decision", () => {
  assert.equal(nightNoteLabel({ kind: "LEFTOVERS" }), "Leftovers");
  assert.equal(nightNoteLabel({ kind: "OUT" }), "Eating out");
});

test("free text refines the kind rather than replacing it", () => {
  assert.equal(
    nightNoteLabel({ kind: "LEFTOVERS", text: "the lasagne from Sunday" }),
    "Leftovers — the lasagne from Sunday",
  );
  assert.equal(
    nightNoteLabel({ kind: "OUT", text: "Mormors fødselsdag" }),
    "Eating out — Mormors fødselsdag",
  );
});

test("OTHER speaks entirely through its text", () => {
  assert.equal(nightNoteLabel({ kind: "OTHER", text: "Fasting" }), "Fasting");
});

test("OTHER with nothing typed still reads as settled, not blank", () => {
  // A blank here would look exactly like the undecided night the note exists to
  // distinguish itself from.
  assert.equal(nightNoteLabel({ kind: "OTHER" }), "No dinner needed");
  assert.equal(nightNoteLabel({ kind: "OTHER", text: null }), "No dinner needed");
  assert.equal(nightNoteLabel({ kind: "OTHER", text: "   " }), "No dinner needed");
});

test("whitespace-only text is not a detail", () => {
  assert.equal(nightNoteLabel({ kind: "LEFTOVERS", text: "  " }), "Leftovers");
});
