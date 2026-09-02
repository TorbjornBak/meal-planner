import assert from "node:assert/strict";
import test from "node:test";

import { runPhotoPass } from "./photoPass.ts";

test("the photo pass keeps three fetches in flight and reports every result", async () => {
  let active = 0;
  let mostActive = 0;
  const progress = [];

  const found = await runPhotoPass(
    ["one", "two", "three", "four", "missing"],
    async (id) => {
      active += 1;
      mostActive = Math.max(mostActive, active);
      await new Promise((resolve) => setImmediate(resolve));
      active -= 1;
      return id !== "missing";
    },
    (state) => progress.push({ ...state }),
  );

  assert.equal(mostActive, 3);
  assert.equal(found, 4);
  assert.deepEqual(progress.at(0), { done: 0, total: 5, found: 0 });
  assert.deepEqual(progress.at(-1), { done: 5, total: 5, found: 4 });
  assert.equal(progress.length, 6);
});
