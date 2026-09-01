// Tests for the production-startup validation (§9, §9b, §11, Phase 6). Run
// with `npm test`.
//
// Everything in src/lib/startupConfig.ts is a total function of an
// environment object, which is the whole reason it's split out of
// src/instrumentation.ts: the part worth getting right — which variable is
// flagged, for which reason, with which message — needs neither a running
// server nor a process willing to have `process.exit` called on it.
// instrumentation.ts owns the one impure step (reading the real
// `process.env` and actually exiting); this only has to prove the table of
// checks is right, in microseconds, on every `npm test`.

import test from "node:test";
import assert from "node:assert/strict";

import { checkStartupConfig, findStartupProblems } from "./startupConfig.ts";

/** A complete, valid production environment — the baseline every test mutates. */
function validEnv(overrides = {}) {
  return {
    NODE_ENV: "production",
    AUTH_SECRET: "a".repeat(32),
    APP_URL: "https://box.example-tailnet.ts.net",
    DATABASE_URL: "postgresql://realuser:realpassword@db:5432/mealplanner?schema=public",
    CRON_SECRET: "b".repeat(32),
    BORG_REPO: "ssh://u123456@u123456.your-storagebox.de:23/./mealplanner",
    BORG_PASSPHRASE: "c".repeat(32),
    ...overrides,
  };
}

function findingsFor(variable, env) {
  return findStartupProblems(env).filter((f) => f.variable === variable);
}

// --- a fully valid environment --------------------------------------------

test("a fully configured, strong environment has no findings", () => {
  assert.deepEqual(findStartupProblems(validEnv()), []);
});

test("a fully configured environment does not block production start", () => {
  const { blocking } = checkStartupConfig(validEnv());
  assert.deepEqual(blocking, []);
});

// --- AUTH_SECRET -----------------------------------------------------------

test("AUTH_SECRET missing is fatal", () => {
  const findings = findingsFor("AUTH_SECRET", validEnv({ AUTH_SECRET: undefined }));
  assert.equal(findings.length, 1);
  assert.equal(findings[0].severity, "fatal");
  assert.match(findings[0].message, /AUTH_SECRET is not set/);
});

test("AUTH_SECRET left at the .env.example placeholder is fatal", () => {
  const findings = findingsFor(
    "AUTH_SECRET",
    validEnv({ AUTH_SECRET: "change-me-to-a-long-random-string" }),
  );
  assert.equal(findings.length, 1);
  assert.equal(findings[0].severity, "fatal");
  assert.match(findings[0].message, /placeholder/);
});

test("AUTH_SECRET present but short is fatal", () => {
  const findings = findingsFor("AUTH_SECRET", validEnv({ AUTH_SECRET: "short" }));
  assert.equal(findings.length, 1);
  assert.equal(findings[0].severity, "fatal");
  assert.match(findings[0].message, /5 characters/);
});

test("AUTH_SECRET present, long and not the placeholder has no finding", () => {
  assert.deepEqual(findingsFor("AUTH_SECRET", validEnv()), []);
});

// --- APP_URL -----------------------------------------------------------

test("APP_URL missing is fatal", () => {
  const findings = findingsFor("APP_URL", validEnv({ APP_URL: undefined }));
  assert.equal(findings.length, 1);
  assert.equal(findings[0].severity, "fatal");
  assert.match(findings[0].message, /APP_URL is not set/);
});

test("APP_URL that doesn't parse as a URL is fatal", () => {
  const findings = findingsFor("APP_URL", validEnv({ APP_URL: "not a url" }));
  assert.equal(findings.length, 1);
  assert.match(findings[0].message, /does not parse/);
});

test("APP_URL over plain http in production is fatal", () => {
  const findings = findingsFor("APP_URL", validEnv({ APP_URL: "http://box.example-tailnet.ts.net" }));
  assert.equal(findings.length, 1);
  assert.equal(findings[0].severity, "fatal");
  assert.match(findings[0].message, /not https/);
});

test("APP_URL over https has no finding", () => {
  assert.deepEqual(findingsFor("APP_URL", validEnv()), []);
});

test("APP_URL left at the .env.example hostname is fatal", () => {
  const findings = findingsFor("APP_URL", validEnv({ APP_URL: "https://box.your-tailnet.ts.net" }));
  assert.equal(findings.length, 1);
  assert.match(findings[0].message, /example/);
});

// --- DATABASE_URL ------------------------------------------------------

test("DATABASE_URL missing is fatal", () => {
  const findings = findingsFor("DATABASE_URL", validEnv({ DATABASE_URL: undefined }));
  assert.equal(findings.length, 1);
  assert.equal(findings[0].severity, "fatal");
  assert.match(findings[0].message, /DATABASE_URL is not set/);
});

test("DATABASE_URL that doesn't parse is fatal", () => {
  const findings = findingsFor("DATABASE_URL", validEnv({ DATABASE_URL: "not-a-connection-string" }));
  assert.equal(findings.length, 1);
  assert.match(findings[0].message, /does not parse/);
});

test("DATABASE_URL with the example mealplanner/mealplanner credentials is fatal", () => {
  const findings = findingsFor(
    "DATABASE_URL",
    validEnv({ DATABASE_URL: "postgresql://mealplanner:mealplanner@db:5432/mealplanner?schema=public" }),
  );
  assert.equal(findings.length, 1);
  assert.equal(findings[0].severity, "fatal");
  assert.match(findings[0].message, /example/);
});

test("DATABASE_URL with a real username but the example password is still fatal", () => {
  // The credentials are a pair; only the pair matching the documented default
  // is the problem, but changing just one half is a common half-fix worth
  // catching too — this asserts the OTHER half, that a real username doesn't
  // mask a default password, since the two conditions must both be checked.
  const findings = findingsFor(
    "DATABASE_URL",
    validEnv({ DATABASE_URL: "postgresql://mealplanner:mealplanner@db:5432/other?schema=public" }),
  );
  assert.equal(findings.length, 1);
});

test("DATABASE_URL with real, distinct credentials has no finding", () => {
  assert.deepEqual(findingsFor("DATABASE_URL", validEnv()), []);
});

test("DATABASE_URL without a username or password is fatal", () => {
  for (const DATABASE_URL of [
    "postgresql://:realpassword@db:5432/mealplanner",
    "postgresql://realuser@db:5432/mealplanner",
  ]) {
    const findings = findingsFor("DATABASE_URL", validEnv({ DATABASE_URL }));
    assert.equal(findings.length, 1, DATABASE_URL);
    assert.match(findings[0].message, /username and password/);
  }
});

// --- CRON_SECRET ---------------------------------------------------------

test("CRON_SECRET missing is fatal", () => {
  const findings = findingsFor("CRON_SECRET", validEnv({ CRON_SECRET: undefined }));
  assert.equal(findings.length, 1);
  assert.match(findings[0].message, /not set/);
});

test("CRON_SECRET left at the .env.example placeholder is fatal", () => {
  const findings = findingsFor(
    "CRON_SECRET",
    validEnv({ CRON_SECRET: "change-me-to-a-long-random-string" }),
  );
  assert.equal(findings.length, 1);
  assert.equal(findings[0].severity, "fatal");
  assert.match(findings[0].message, /placeholder/);
});

test("CRON_SECRET present but short is fatal", () => {
  const findings = findingsFor("CRON_SECRET", validEnv({ CRON_SECRET: "short" }));
  assert.equal(findings.length, 1);
  assert.equal(findings[0].severity, "fatal");
});

test("CRON_SECRET present, long and not the placeholder has no finding", () => {
  assert.deepEqual(findingsFor("CRON_SECRET", validEnv()), []);
});

// --- BORG_PASSPHRASE -----------------------------------------------------

test("production backup configuration is required", () => {
  const findings = findStartupProblems(
    validEnv({ BORG_REPO: undefined, BORG_PASSPHRASE: undefined }),
  ).filter((finding) => finding.variable === "BORG_REPO" || finding.variable === "BORG_PASSPHRASE");
  assert.deepEqual(findings.map((finding) => finding.variable), ["BORG_REPO", "BORG_PASSPHRASE"]);
});

test("BORG_REPO set with BORG_PASSPHRASE unset is fatal", () => {
  const findings = findingsFor("BORG_PASSPHRASE", validEnv({ BORG_PASSPHRASE: undefined }));
  assert.equal(findings.length, 1);
  assert.match(findings[0].message, /not set/);
});

test("BORG_PASSPHRASE left at the .env.example placeholder on a configured repo is fatal", () => {
  const findings = findingsFor(
    "BORG_PASSPHRASE",
    validEnv({ BORG_PASSPHRASE: "change-me-to-a-long-random-string" }),
  );
  assert.equal(findings.length, 1);
  assert.equal(findings[0].severity, "fatal");
  assert.match(findings[0].message, /placeholder|configured repository/);
});

test("BORG_PASSPHRASE present but short on a configured repo is fatal", () => {
  const findings = findingsFor("BORG_PASSPHRASE", validEnv({ BORG_PASSPHRASE: "short" }));
  assert.equal(findings.length, 1);
  assert.equal(findings[0].severity, "fatal");
});

test("BORG_PASSPHRASE present, long and not the placeholder on a configured repo has no finding", () => {
  assert.deepEqual(findingsFor("BORG_PASSPHRASE", validEnv()), []);
});

// --- development vs. production -------------------------------------------

test("outside production, nothing blocks even with every variable missing", () => {
  const env = {
    NODE_ENV: "development",
    AUTH_SECRET: undefined,
    APP_URL: undefined,
    DATABASE_URL: undefined,
    CRON_SECRET: "change-me-to-a-long-random-string",
    BORG_REPO: "ssh://u123456@u123456.your-storagebox.de:23/./mealplanner",
    BORG_PASSPHRASE: "change-me-to-a-long-random-string",
  };
  const { findings, blocking } = checkStartupConfig(env);
  // The same findings are still computed and worth printing as warnings...
  assert.ok(findings.length >= 4);
  // ...but nothing here refuses to start a `next dev` or `node --test` run.
  assert.deepEqual(blocking, []);
});

test("NODE_ENV unset (as in a bare `node --test` run) behaves like development, not production", () => {
  const { blocking } = checkStartupConfig({ AUTH_SECRET: undefined });
  assert.deepEqual(blocking, []);
});

test("in production, every fatal finding is reported at once, not one restart apiece", () => {
  const env = validEnv({
    AUTH_SECRET: undefined,
    APP_URL: undefined,
    DATABASE_URL: undefined,
    CRON_SECRET: "change-me-to-a-long-random-string",
    BORG_PASSPHRASE: "change-me-to-a-long-random-string",
  });
  const { blocking } = checkStartupConfig(env);
  const variables = blocking.map((f) => f.variable).sort();
  assert.deepEqual(variables, ["APP_URL", "AUTH_SECRET", "BORG_PASSPHRASE", "CRON_SECRET", "DATABASE_URL"]);
});

test("in production, a single problem still blocks", () => {
  const { blocking } = checkStartupConfig(validEnv({ AUTH_SECRET: undefined }));
  assert.equal(blocking.length, 1);
  assert.equal(blocking[0].variable, "AUTH_SECRET");
});
