// Tests for what a receipt photo may be (§7, Phase 6). Run with `npm test`.
//
// These are the rules that stand between a member's upload and a response
// this app serves from its own origin, so the cases below are written as the
// attack they refuse rather than as the field they check. The hole they close
// is concrete: before Phase 6, POST /api/trips wrote `photo.type` — whatever
// the uploader's browser claimed — into the database, and
// GET /api/trips/[id]/receipt handed it straight back as a `Content-Type`.
// A file announcing itself as text/html therefore rendered as a document on
// the app's origin, with the session cookie on every request it made.

import test from "node:test";
import assert from "node:assert/strict";

import {
  MAX_RECEIPT_PHOTO_BYTES,
  isAllowedReceiptMime,
  receiptPhotoProblem,
  safeReceiptContentType,
} from "./receiptPhoto.ts";

/** A stand-in for the `File` the route pulls out of a multipart form. */
function upload({ size = 1024, type = "image/jpeg" } = {}) {
  return { size, type };
}

// --- what gets in ---------------------------------------------------------

test("an ordinary phone photo is accepted", () => {
  assert.equal(receiptPhotoProblem(upload({ size: 2_000_000, type: "image/jpeg" })), null);
  assert.equal(receiptPhotoProblem(upload({ type: "image/heic" })), null);
});

test("a browser's charset parameter doesn't make a valid type invalid", () => {
  assert.equal(receiptPhotoProblem(upload({ type: "image/jpeg; charset=binary" })), null);
  assert.equal(receiptPhotoProblem(upload({ type: "IMAGE/JPEG" })), null);
});

test("an HTML file posing as a receipt is refused", () => {
  // The stored-XSS case, and the whole reason this module exists.
  const problem = receiptPhotoProblem(upload({ type: "text/html" }));
  assert.ok(problem, "an HTML upload must be refused");
  assert.match(problem, /JPEG|PNG|WebP|HEIC/);
});

test("an SVG is refused even though it is nominally an image", () => {
  // `type.startsWith("image/")` would admit this. SVG is a document format
  // that can carry script and is rendered inline, so it would reopen the hole
  // by a side door.
  assert.ok(receiptPhotoProblem(upload({ type: "image/svg+xml" })));
});

test("an upload with no type at all is refused rather than defaulted", () => {
  // The old code substituted "application/octet-stream" for a missing type
  // and stored the file anyway.
  assert.ok(receiptPhotoProblem(upload({ type: "" })));
});

test("the size cap is enforced at the boundary, not near it", () => {
  assert.equal(receiptPhotoProblem(upload({ size: MAX_RECEIPT_PHOTO_BYTES })), null);
  const problem = receiptPhotoProblem(upload({ size: MAX_RECEIPT_PHOTO_BYTES + 1 }));
  assert.ok(problem);
  assert.match(problem, /10 MB/);
});

test("an empty file is refused before anything is stored", () => {
  assert.ok(receiptPhotoProblem(upload({ size: 0 })));
});

test("the cap and the middleware envelope stay a matched pair", () => {
  // next.config.mjs raises the middleware body limit to 11 MB precisely so a
  // 10 MB photo plus multipart framing survives the trip to the handler
  // (src/lib/receiptUpload.test.mjs asserts that end of it). If this number
  // ever exceeds that envelope, uploads start failing at the boundary with a
  // truncated form rather than an honest 413.
  assert.equal(MAX_RECEIPT_PHOTO_BYTES, 10 * 1024 * 1024);
});

// --- what gets served back ------------------------------------------------

test("a stored image type is served as itself", () => {
  assert.equal(safeReceiptContentType("image/jpeg"), "image/jpeg");
  assert.equal(safeReceiptContentType("image/png; charset=binary"), "image/png");
});

test("a stored type from before validation degrades to a download", () => {
  // Rows written before Phase 6 carry whatever their uploader claimed, so the
  // way out is checked rather than trusted. octet-stream is downloaded rather
  // than rendered, which keeps the receipt retrievable while making it inert.
  assert.equal(safeReceiptContentType("text/html"), "application/octet-stream");
  assert.equal(safeReceiptContentType("image/svg+xml"), "application/octet-stream");
  assert.equal(safeReceiptContentType(null), "application/octet-stream");
  assert.equal(safeReceiptContentType(undefined), "application/octet-stream");
});

test("the allowlist is the same on the way in and the way out", () => {
  // Two lists would drift, and the direction they drift in is the dangerous
  // one: a type accepted at upload but unrecognised on serving is merely
  // annoying, while the reverse is the hole reopening.
  for (const mime of ["image/jpeg", "image/png", "image/webp", "image/heic", "image/heif"]) {
    assert.equal(receiptPhotoProblem(upload({ type: mime })), null, `${mime} should upload`);
    assert.equal(safeReceiptContentType(mime), mime, `${mime} should serve as itself`);
    assert.ok(isAllowedReceiptMime(mime));
  }
});
