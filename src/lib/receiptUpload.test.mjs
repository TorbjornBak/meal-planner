import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { PassThrough } from "node:stream";
import test from "node:test";

import nextConfig from "../../next.config.mjs";

const require = createRequire(import.meta.url);
const bytes = require("next/dist/compiled/bytes");
const { getCloneableBody } = require("next/dist/server/body-streams");

const MAX_RECEIPT_PHOTO_BYTES = 10 * 1024 * 1024;
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
