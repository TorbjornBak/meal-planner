import test from "node:test";
import assert from "node:assert/strict";
import { withImportRouteSecurity } from "./importRouteSecurity.ts";

const env = {
  NODE_ENV: "production",
  APP_URL: "https://meals.example.test",
  TURNSTILE_ENABLED: "false",
};

function request(origin = "https://meals.example.test") {
  return new Request("https://meals.example.test/api/recipes/import", {
    method: "POST",
    headers: { origin },
    body: '{"format":"mealplanner.recipes"}',
  });
}

test("the middleware-free import keeps the same-origin check", async () => {
  let called = false;
  const response = await withImportRouteSecurity(
    request("https://attacker.example"),
    async () => {
      called = true;
      return Response.json({ ok: true });
    },
    env,
  );
  assert.equal(response.status, 403);
  assert.equal(called, false);
  assert.deepEqual(await response.json(), { error: "request rejected" });
});

test("an allowed import reaches the handler and gets security headers", async () => {
  const response = await withImportRouteSecurity(
    request(),
    async () => Response.json({ error: "unauthorized" }, { status: 401 }),
    env,
  );
  assert.equal(response.status, 401);
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.match(response.headers.get("content-security-policy"), /frame-ancestors 'none'/);
  assert.match(response.headers.get("strict-transport-security"), /max-age=/);
});

test("handler failures remain JSON responses with security headers", async (t) => {
  t.mock.method(console, "error", () => {});
  const response = await withImportRouteSecurity(
    request(),
    async () => { throw new Error("database unavailable"); },
    env,
  );
  assert.equal(response.status, 500);
  assert.match((await response.json()).error, /server could not complete/);
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
});
