import test from "node:test";
import assert from "node:assert/strict";
import { readRecipeTransferBody } from "./readRecipeTransferBody.ts";

test("a recipe transfer body is read as JSON", async () => {
  const request = new Request("https://meals.example/api/recipes/import", {
    method: "POST",
    body: '{"recipes":[]}',
  });
  assert.deepEqual(await readRecipeTransferBody(request, 100), {
    ok: true,
    body: { recipes: [] },
  });
});

test("an oversized body gets a JSON-ready 413 explanation", async () => {
  const request = new Request("https://meals.example/api/recipes/import", {
    method: "POST",
    body: '{"recipes":[]}',
  });
  const result = await readRecipeTransferBody(request, 5);
  assert.equal(result.ok, false);
  assert.equal(result.status, 413);
  assert.match(result.message, /too large/);
});
