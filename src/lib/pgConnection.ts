/**
 * Handing Prisma's DATABASE_URL to pg_dump (§11).
 *
 * They don't take the same string. Prisma's URL carries settings of its own —
 * `?schema=public`, `connection_limit`, `pgbouncer` — and libpq, which is what
 * pg_dump parses its URL with, rejects the whole connection with "invalid URI
 * query parameter" the moment it meets one it doesn't know. A nightly backup
 * that fails on the URL it was given is a bad way to find that out, so the
 * cleaning happens here, in a pure function with tests, rather than in a shell
 * pipeline at three in the morning.
 */

/**
 * Query parameters libpq understands. Anything else is Prisma's business and
 * is dropped.
 *
 * An allow-list rather than a deny-list: a new Prisma parameter appearing in a
 * URL should cost nothing, where a new libpq parameter being silently dropped
 * would at worst turn TLS off — which is why `sslmode` and its friends are all
 * here.
 */
const LIBPQ_PARAMS = new Set([
  "application_name",
  "channel_binding",
  "connect_timeout",
  "fallback_application_name",
  "gssencmode",
  "keepalives",
  "keepalives_count",
  "keepalives_idle",
  "keepalives_interval",
  "options",
  "passfile",
  "requiressl",
  "sslcert",
  "sslcompression",
  "sslcrl",
  "sslkey",
  "sslmode",
  "sslpassword",
  "sslrootcert",
  "target_session_attrs",
]);

/** Thrown when DATABASE_URL isn't a Postgres URL at all. */
export class DatabaseUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DatabaseUrlError";
  }
}

/**
 * DATABASE_URL, reduced to what libpq accepts.
 *
 * The `schema` parameter is dropped rather than translated into `--schema`:
 * the dump takes the whole database, so a restore can't be short of a table
 * because someone's search path differed from the flag.
 */
export function libpqUrl(databaseUrl: string): string {
  const raw = databaseUrl?.trim();
  if (!raw) throw new DatabaseUrlError("DATABASE_URL is not set, so there is nothing to dump.");

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new DatabaseUrlError("DATABASE_URL isn't a URL pg_dump can parse.");
  }

  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") {
    throw new DatabaseUrlError(
      `DATABASE_URL is a ${url.protocol.replace(":", "")} URL; backups only know how to dump Postgres.`,
    );
  }

  for (const key of [...url.searchParams.keys()]) {
    if (!LIBPQ_PARAMS.has(key)) url.searchParams.delete(key);
  }

  return url.toString();
}

/**
 * The pg_dump invocation.
 *
 * Plain SQL rather than the custom format: a text stream deduplicates against
 * last night's (see createArgs in borgConfig.ts), and restoring needs nothing
 * but psql — no pg_restore, no matching major version, no flags to remember on
 * the worst day of the year.
 *
 * `--clean --if-exists` so the restore runs against the database that's already
 * there — the usual case, a container that came back with an empty-but-migrated
 * schema — instead of failing on objects that exist. `--no-owner` and
 * `--no-privileges` so it doesn't matter which role does the restoring.
 */
export function pgDumpArgs(databaseUrl: string): string[] {
  return [
    "--no-owner",
    "--no-privileges",
    "--clean",
    "--if-exists",
    "--dbname",
    libpqUrl(databaseUrl),
  ];
}

/** The same URL with the password blanked, for logs and the settings screen. */
export function redactDatabaseUrl(databaseUrl: string): string {
  try {
    const url = new URL(databaseUrl);
    if (url.password) url.password = "***";
    return url.toString();
  } catch {
    return "(unparseable DATABASE_URL)";
  }
}
