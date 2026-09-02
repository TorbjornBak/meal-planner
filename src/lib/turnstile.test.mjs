import test from "node:test";
import assert from "node:assert/strict";

const { verifyTurnstile } = await import("./turnstile.ts");
const { TURNSTILE_ACTIONS } = await import("./turnstileActions.ts");

test("the protected surfaces use the approved stable Turnstile actions", () => {
  assert.deepEqual(TURNSTILE_ACTIONS, {
    login: "login",
    setup: "setup",
    passwordForgot: "password_forgot",
    passwordReset: "password_reset",
    invitationAccept: "invitation_accept",
  });
  for (const action of Object.values(TURNSTILE_ACTIONS)) {
    assert.match(action, /^[A-Za-z0-9_-]{1,32}$/);
  }
});

test("a missing Turnstile token is rejected without contacting Cloudflare", async (t) => {
  const fetchMock = t.mock.method(globalThis, "fetch", async () => {
    throw new Error("fetch should not be called");
  });

  const verified = await verifyTurnstile(new Request("https://mealplanner.example/api/login"), "", "login");

  assert.equal(verified, false);
  assert.equal(fetchMock.mock.callCount(), 0);
});

test("a valid token is accepted for its exact action and approved hostname", async (t) => {
  const previousSecret = process.env.TURNSTILE_SECRET;
  const previousHostnames = process.env.TURNSTILE_HOSTNAMES;
  process.env.TURNSTILE_SECRET = "test-secret";
  process.env.TURNSTILE_HOSTNAMES = "mealplanner.torbjornregueira.com";
  t.after(() => {
    if (previousSecret === undefined) delete process.env.TURNSTILE_SECRET;
    else process.env.TURNSTILE_SECRET = previousSecret;
    if (previousHostnames === undefined) delete process.env.TURNSTILE_HOSTNAMES;
    else process.env.TURNSTILE_HOSTNAMES = previousHostnames;
  });

  const fetchMock = t.mock.method(globalThis, "fetch", async (_url, init) => {
    const body = new URLSearchParams(init.body);
    assert.equal(body.get("secret"), "test-secret");
    assert.equal(body.get("response"), "browser-token");
    assert.equal(body.get("remoteip"), "203.0.113.9");
    return Response.json({
      success: true,
      action: "login",
      hostname: "mealplanner.torbjornregueira.com",
    });
  });

  const request = new Request("https://mealplanner.torbjornregueira.com/api/login", {
    headers: { "x-forwarded-for": "198.51.100.2, 203.0.113.9" },
  });
  const verified = await verifyTurnstile(request, "browser-token", "login");

  assert.equal(verified, true);
  assert.equal(fetchMock.mock.callCount(), 1);
  assert.equal(fetchMock.mock.calls[0].arguments[0], "https://challenges.cloudflare.com/turnstile/v0/siteverify");
});

test("successful Siteverify responses with the wrong action or hostname are rejected", async (t) => {
  const previousSecret = process.env.TURNSTILE_SECRET;
  const previousHostnames = process.env.TURNSTILE_HOSTNAMES;
  process.env.TURNSTILE_SECRET = "test-secret";
  process.env.TURNSTILE_HOSTNAMES = "mealplanner.torbjornregueira.com,other.example.com";
  t.after(() => {
    if (previousSecret === undefined) delete process.env.TURNSTILE_SECRET;
    else process.env.TURNSTILE_SECRET = previousSecret;
    if (previousHostnames === undefined) delete process.env.TURNSTILE_HOSTNAMES;
    else process.env.TURNSTILE_HOSTNAMES = previousHostnames;
  });

  let result = { success: true, action: "setup", hostname: "mealplanner.torbjornregueira.com" };
  t.mock.method(globalThis, "fetch", async () => Response.json(result));

  const request = new Request("https://mealplanner.torbjornregueira.com/api/login");
  assert.equal(await verifyTurnstile(request, "first-token", "login"), false);

  result = { success: true, action: "login", hostname: "attacker.example.com" };
  assert.equal(await verifyTurnstile(request, "second-token", "login"), false);
});

test("missing configuration and oversized tokens fail closed before Siteverify", async (t) => {
  const previousSecret = process.env.TURNSTILE_SECRET;
  const previousHostnames = process.env.TURNSTILE_HOSTNAMES;
  delete process.env.TURNSTILE_SECRET;
  delete process.env.TURNSTILE_HOSTNAMES;
  t.after(() => {
    if (previousSecret === undefined) delete process.env.TURNSTILE_SECRET;
    else process.env.TURNSTILE_SECRET = previousSecret;
    if (previousHostnames === undefined) delete process.env.TURNSTILE_HOSTNAMES;
    else process.env.TURNSTILE_HOSTNAMES = previousHostnames;
  });

  const fetchMock = t.mock.method(globalThis, "fetch", async () => {
    throw new Error("fetch should not be called");
  });
  const request = new Request("https://mealplanner.torbjornregueira.com/api/login");

  assert.equal(await verifyTurnstile(request, "token", "login"), false);

  process.env.TURNSTILE_SECRET = "test-secret";
  process.env.TURNSTILE_HOSTNAMES = "mealplanner.torbjornregueira.com";
  assert.equal(await verifyTurnstile(request, "x".repeat(2049), "login"), false);
  assert.equal(fetchMock.mock.callCount(), 0);
});

test("Siteverify network and response failures are rejected instead of escaping", async (t) => {
  const previousSecret = process.env.TURNSTILE_SECRET;
  const previousHostnames = process.env.TURNSTILE_HOSTNAMES;
  process.env.TURNSTILE_SECRET = "test-secret";
  process.env.TURNSTILE_HOSTNAMES = "mealplanner.torbjornregueira.com";
  t.after(() => {
    if (previousSecret === undefined) delete process.env.TURNSTILE_SECRET;
    else process.env.TURNSTILE_SECRET = previousSecret;
    if (previousHostnames === undefined) delete process.env.TURNSTILE_HOSTNAMES;
    else process.env.TURNSTILE_HOSTNAMES = previousHostnames;
  });

  let response = "network-error";
  t.mock.method(globalThis, "fetch", async () => {
    if (response === "network-error") throw new Error("offline");
    if (response === "bad-json") return new Response("not json");
    return new Response(null, { status: 503 });
  });
  const request = new Request("https://mealplanner.torbjornregueira.com/api/login");

  assert.equal(await verifyTurnstile(request, "first-token", "login"), false);
  response = "bad-json";
  assert.equal(await verifyTurnstile(request, "second-token", "login"), false);
  response = "non-ok";
  assert.equal(await verifyTurnstile(request, "third-token", "login"), false);
});
