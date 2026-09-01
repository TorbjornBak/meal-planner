// Tests for the DATABASE_URL → pg_dump translation (§11). Run with `npm test`.

import test from "node:test";
import assert from "node:assert/strict";

import { DatabaseUrlError, libpqUrl, pgDumpArgs, redactDatabaseUrl } from "./pgConnection.ts";

const PRISMA_URL = "postgresql://mealplanner:secret@db:5432/mealplanner?schema=public";

test("Prisma's schema parameter is dropped, because libpq refuses the connection over it", () => {
  assert.equal(libpqUrl(PRISMA_URL), "postgresql://mealplanner:secret@db:5432/mealplanner");
});

test("every other Prisma-only parameter goes too", () => {
  const url = libpqUrl(
    "postgresql://u:p@db:5432/mealplanner?schema=public&connection_limit=5&pgbouncer=true&pool_timeout=10",
  );
  assert.equal(url, "postgresql://u:p@db:5432/mealplanner");
});

test("libpq's own parameters are kept — dropping sslmode would quietly downgrade the connection", () => {
  const url = libpqUrl("postgresql://u:p@db:5432/mealplanner?schema=public&sslmode=require&connect_timeout=10");
  assert.match(url, /sslmode=require/);
  assert.match(url, /connect_timeout=10/);
  assert.doesNotMatch(url, /schema/);
});

test("a URL with nothing to clean survives unchanged", () => {
  const plain = "postgresql://u:p@db:5432/mealplanner";
  assert.equal(libpqUrl(plain), plain);
});

test("the postgres:// spelling is accepted as well", () => {
  assert.equal(
    libpqUrl("postgres://u:p@db:5432/mealplanner?schema=public"),
    "postgres://u:p@db:5432/mealplanner",
  );
});

test("a percent-escaped password comes out still escaped, which is what libpq wants", () => {
  // %40 is an @ and %2F a slash. Decoding them here would produce a URL that
  // reads as user "u" on host "ss/word@db" — libpq does its own decoding, so
  // the escaping has to survive this function untouched.
  const url = libpqUrl("postgresql://u:p%40ss%2Fword@db:5432/mealplanner?schema=public");
  assert.equal(url, "postgresql://u:p%40ss%2Fword@db:5432/mealplanner");
  assert.equal(new URL(url).hostname, "db");
});

test("an unset or unparseable URL fails with a sentence, not a stack trace", () => {
  assert.throws(() => libpqUrl(""), DatabaseUrlError);
  assert.throws(() => libpqUrl("   "), DatabaseUrlError);
  assert.throws(() => libpqUrl("not a url"), DatabaseUrlError);
});

test("a non-Postgres URL is refused by name", () => {
  assert.throws(() => libpqUrl("mysql://u:p@db:3306/mealplanner"), /only know how to dump Postgres/);
});

test("pg_dump is asked for a restorable plain-SQL dump", () => {
  const args = pgDumpArgs(PRISMA_URL);
  assert.deepEqual(args.slice(0, 4), ["--no-owner", "--no-privileges", "--clean", "--if-exists"]);
  assert.equal(args.at(-2), "--dbname");
  assert.equal(args.at(-1), "postgresql://mealplanner:secret@db:5432/mealplanner");
});

test("the password is blanked for anything that gets shown or logged", () => {
  assert.equal(
    redactDatabaseUrl(PRISMA_URL),
    "postgresql://mealplanner:***@db:5432/mealplanner?schema=public",
  );
  assert.equal(redactDatabaseUrl("nonsense"), "(unparseable DATABASE_URL)");
});
