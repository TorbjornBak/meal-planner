// Tests for handing a timer to the device's clock (§2). Run with `npm test`.
//
// The user agents below are real ones — the point of the detection is the
// awkward cases (an iPad calling itself a Mac), so they have to be verbatim.

import test from "node:test";
import assert from "node:assert/strict";

import { detectPlatform, deviceTimer, DEFAULT_SHORTCUT } from "./deviceTimer.ts";

const UA = {
  androidChrome:
    "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36",
  iphone:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1",
  ipad:
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15",
  mac:
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
  windows:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
  linux:
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
};

test("each platform is recognised", () => {
  assert.equal(detectPlatform(UA.androidChrome), "android");
  assert.equal(detectPlatform(UA.iphone), "ios");
  assert.equal(detectPlatform(UA.mac), "macos");
  assert.equal(detectPlatform(UA.windows), "windows");
  assert.equal(detectPlatform(UA.linux), "other");
});

test("an iPad claiming to be a Mac is caught by its touchscreen", () => {
  // Identical user agents; only the touch points tell them apart.
  assert.equal(detectPlatform(UA.ipad, 5), "ios");
  assert.equal(detectPlatform(UA.mac, 0), "macos");
});

test("Android gets a real, labelled, silent timer", () => {
  const t = deviceTimer("android", 1200, "Simre saucen");
  assert.equal(t.kind, "starts");
  assert.match(t.url, /^intent:#Intent;action=android\.intent\.action\.SET_TIMER;/);
  assert.match(t.url, /i\.android\.intent\.extra\.alarm\.LENGTH=1200;/);
  assert.match(t.url, /B\.android\.intent\.extra\.alarm\.SKIP_UI=true;end$/);
});

test("a step label can't break out of the intent URI", () => {
  // ';' ends an intent field and '#' starts one — both have to be encoded.
  const t = deviceTimer("android", 60, "Steg; #Intent;action=evil");
  // The MESSAGE field must hold no raw ';' or '#' — only its own terminator.
  const message = t.url.match(/MESSAGE=([^;]*);/)[1];
  assert.ok(!/[;#]/.test(message));
  assert.ok(!/MESSAGE=[^;]*[#]/.test(t.url));
  assert.match(t.url, /MESSAGE=Steg%3B%20%23Intent%3Baction%3Devil;/);
});

test("Apple platforms go through the user's shortcut", () => {
  const t = deviceTimer("ios", 90, "Blancher", "Kokketimer");
  assert.equal(t.url, "shortcuts://run-shortcut?name=Kokketimer&input=text&text=90");
  // A blank name falls back rather than producing a broken URL.
  assert.match(deviceTimer("macos", 90, "x", "  ").url, new RegExp(encodeURIComponent(DEFAULT_SHORTCUT)));
});

test("Windows can only be opened, and says so", () => {
  const t = deviceTimer("windows", 1200, "Bag");
  assert.equal(t.url, "ms-clock:");
  assert.equal(t.kind, "opens");
  assert.match(t.hint, /you set it/);
});

test("platforms with no route offer nothing rather than a dead button", () => {
  assert.equal(deviceTimer("other", 600, "Simre"), null);
});

test("sub-second and fractional lengths are rounded to a usable timer", () => {
  assert.match(deviceTimer("android", 0.2, "x").url, /LENGTH=1;/);
  assert.equal(deviceTimer("ios", 89.6, "x").url.endsWith("text=90"), true);
});
