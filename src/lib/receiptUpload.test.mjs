import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { PassThrough } from "node:stream";
import test from "node:test";

import nextConfig from "../../next.config.mjs";
import { MAX_RECEIPT_PHOTO_BYTES } from "./receiptPhoto.ts";

const require = createRequire(import.meta.url);
const bytes = require("next/dist/compiled/bytes");
const { getCloneableBody } = require("next/dist/server/body-streams");

// The cap the route actually enforces, imported rather than restated: this
// test's whole point is that the middleware envelope in next.config.mjs is
// wide enough for it, and two copies of the number could drift apart into a
// green test over a limit nothing uses.
const MULTIPART_ENVELOPE_BYTES = 1024;

test("middleware preserves a maximum-size receipt upload for the route handler", async () => {
  const request = new PassThrough();
  request.url = "/api/trips";

  const configuredLimit =
    nextConfig.experimental?.middlewareClientMaxBodySize;
  const limit =
    typeof configuredLimit === "string"
      ? bytes.parse(configuredLimit)
      : configuredLimit;

  const cloneable = getCloneableBody(request, limit);
  const middlewareBody = cloneable.cloneBodyStream();
  const received = [];
  const complete = new Promise((resolve, reject) => {
    middlewareBody.on("data", (chunk) => received.push(chunk));
    middlewareBody.on("end", resolve);
    middlewareBody.on("error", reject);
  });

  const upload = Buffer.alloc(
    MAX_RECEIPT_PHOTO_BYTES + MULTIPART_ENVELOPE_BYTES,
  );
  request.end(upload);
  await complete;

  assert.equal(Buffer.concat(received).byteLength, upload.byteLength);
});
