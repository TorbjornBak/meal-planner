// Tests for the streaming size cap shared by `fetchImage` here and
// `fetchPageHtml` in fetchPage.ts (Security review, LOW-1). Run with
// `npm test`.
//
// The bug this guards against: buffering a whole response body and only
// checking its size afterwards lets a host that omits (or lies about)
// Content-Length force an unbounded allocation from a single pasted recipe
// URL. `readCapped` has to bail out *while* reading, not after, so these
// tests build a response whose body streams in chunks and check that an
// oversized stream is cut off before it's fully consumed, while a stream
// under the cap comes through byte-for-byte.

import test from "node:test";
import assert from "node:assert/strict";

import { readCapped } from "./image.ts";

/**
 * A Response whose body is a ReadableStream yielding `chunks` one per pull
 * rather than all at once — closer to a real network body, and the part that
 * matters for the overrun test below: a stream that hands over every chunk
 * and closes itself before `readCapped` ever gets a chance to cancel it would
 * make "cancelled" trivially true regardless of whether the cap logic
 * actually cancels early.
 */
function streamedResponse(chunks) {
  let cancelled = false;
  let i = 0;
  const stream = new ReadableStream({
    pull(controller) {
      if (i < chunks.length) controller.enqueue(chunks[i++]);
      else controller.close();
    },
    cancel() {
      cancelled = true;
    },
  });
  const res = new Response(stream);
  return { res, wasCancelled: () => cancelled };
}

test("a stream under the cap passes through intact", async () => {
  const a = new Uint8Array([1, 2, 3]);
  const b = new Uint8Array([4, 5]);
  const { res } = streamedResponse([a, b]);

  const bytes = await readCapped(res, 10);

  assert.ok(bytes);
  assert.deepEqual([...bytes], [1, 2, 3, 4, 5]);
});

test("a stream exactly at the cap passes through intact", async () => {
  const a = new Uint8Array([1, 2, 3]);
  const { res } = streamedResponse([a]);

  const bytes = await readCapped(res, 3);

  assert.ok(bytes);
  assert.deepEqual([...bytes], [1, 2, 3]);
});

test("a stream that overruns the cap is aborted rather than fully buffered", async () => {
  const chunks = [
    new Uint8Array(4).fill(1),
    new Uint8Array(4).fill(2),
    new Uint8Array(4).fill(3), // running total 12 > cap of 10 partway through this chunk
  ];
  const { res, wasCancelled } = streamedResponse(chunks);

  const bytes = await readCapped(res, 10);

  assert.equal(bytes, null);
  assert.equal(wasCancelled(), true, "the underlying stream should be cancelled, not drained");
});

test("an empty body reads as zero bytes, not null", async () => {
  const { res } = streamedResponse([]);

  const bytes = await readCapped(res, 10);

  assert.ok(bytes);
  assert.equal(bytes.byteLength, 0);
});

test("a response with no body at all reads as zero bytes", async () => {
  const res = new Response(null, { status: 204 });

  const bytes = await readCapped(res, 10);

  assert.ok(bytes);
  assert.equal(bytes.byteLength, 0);
});
