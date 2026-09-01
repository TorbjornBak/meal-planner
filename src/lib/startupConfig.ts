/**
 * Whether this process is safe to start (Phase 6, "fail production startup").
 *
 * Pure, for the reason src/lib/rateLimitPolicy.ts and src/lib/borgConfig.ts
 * are pure: the interesting part — which variable, what's wrong with it, and
 * what to type instead — is a table of string checks that needs neither a
 * running server nor a container to exercise. src/instrumentation.ts does the
 * one impure thing this can't: reading `process.env` and, in production,
 * calling `process.exit`.
 *
 * Every finding here carries the severity it *would* have in production, and
 * is computed the same way in every environment. It is instrumentation.ts —
 * not this module — that decides, based on NODE_ENV, whether a "fatal" finding
 * actually blocks the process or is merely printed. That split is what makes
 * "the same findings are warnings in development" a one-line decision at the
 * call site instead of two copies of the checks.
 *
 * AUTH_SECRET is the sharpest reason this exists. src/lib/auth.ts has always
 * thrown "AUTH_SECRET is not set" — but lazily, the first time some code path
 * calls secret(), which in practice means the first sign-in, the first
 * capture-token check, or the first newsletter tick. A box with no
 * AUTH_SECRET boots clean, serves the marketing-flavoured parts of every page
 * that don't touch auth, and only falls over hours later on whoever tries to
 * use it — at which point the person looking at the error is a household
 * member, not whoever deployed the box. Checking this once, at startup, moves
 * that failure to the one place someone is actually watching the logs.
 */

/**
 * Two severities, and they mean different things to instrumentation.ts:
 *
 *   fatal    refuses a production start. Reserved for problems that would
 *            either brick the app the moment someone used the affected
 *            feature (AUTH_SECRET, DATABASE_URL, APP_URL) or hand a stranger
 *            a credential this repository publishes in cleartext
 *            (CRON_SECRET / BORG_PASSPHRASE left at the .env.example value).
 *   warning  worth a loud line in the log, never worth refusing to boot.
 *            Nothing currently reaches this severity in production — every
 *            check below is either "fine" or "fatal" — but the type exists so
 *            a future check (a deprecated variable, say) has somewhere to
 *            land without every fatal problem needing a sibling case.
 */
export type StartupSeverity = "fatal" | "warning";

export interface StartupFinding {
  /** The environment variable this finding is about. */
  variable: string;
  severity: StartupSeverity;
  /**
   * A full sentence (or two): what's wrong, and what to type instead. Written
   * for whoever is looking at a container that won't start, not for whoever
   * wrote this file.
   */
  message: string;
}

export interface StartupCheck {
  /** Every finding, in every environment — this is what development prints. */
  findings: StartupFinding[];
  /**
   * The subset of `findings` that should stop a production process starting.
   * Always empty when `env.NODE_ENV !== "production"`: the whole point of
   * this field is that development and test runs stay usable with a
   * half-configured `.env` (see README) while a production container refuses
   * to come up misconfigured.
   */
  blocking: StartupFinding[];
}

/**
 * The exact placeholder .env.example ships for AUTH_SECRET, CRON_SECRET and
 * BORG_PASSPHRASE. It's checked for literal equality, not as a substring or a
 * pattern, because .env.example is committed and public — anyone who has
 * cloned this repository (or read it on the web) already knows this string,
 * so a secret left equal to it is worse than an unset one: unset fails
 * closed, this fails open to whoever thought to try it.
 */
const PLACEHOLDER_SECRET = "change-me-to-a-long-random-string";

/**
 * The example DATABASE_URL credentials, from .env.example and the defaults
 * baked into docker-compose.yml's `${POSTGRES_USER:-mealplanner}`. Checked
 * against DATABASE_URL itself, not against POSTGRES_USER/POSTGRES_PASSWORD:
 * docker-compose.yml only ever hands the app container the assembled
 * DATABASE_URL, never the two Postgres variables it was built from (see
 * docker-compose.yml's `app.environment` block), so DATABASE_URL is the only
 * place this process can actually observe them.
 */
const EXAMPLE_DB_USER = "mealplanner";
const EXAMPLE_DB_PASSWORD = "mealplanner";

/**
 * Below this, a secret is either a short human-chosen string or a leftover
 * default — real generated secrets clear it by a wide margin (the
 * `openssl rand -base64 32` this repo suggests produces 44 characters). This
 * is a length floor, not an entropy check: measuring entropy honestly needs a
 * library, and this repo's whole reason for hashing passwords with
 * node:crypto instead of a dependency (§9, §12) is not wanting one for
 * exactly this kind of check. Twenty characters is chosen to sit comfortably
 * under any pasted-in generated secret while still catching "letmein" and
 * "mealplanner2024".
 */
const MIN_SECRET_LENGTH = 20;

function pushIfPlaceholderOrShort(
  findings: StartupFinding[],
  variable: string,
  value: string,
  describePlaceholder: () => string,
  describeShort: (length: number) => string,
): void {
  if (value === PLACEHOLDER_SECRET) {
    findings.push({ variable, severity: "fatal", message: describePlaceholder() });
    return;
  }
  if (value.length < MIN_SECRET_LENGTH) {
    findings.push({ variable, severity: "fatal", message: describeShort(value.length) });
  }
}

function checkAuthSecret(env: NodeJS.ProcessEnv, findings: StartupFinding[]): void {
  const raw = env.AUTH_SECRET?.trim() ?? "";
  if (!raw) {
    findings.push({
      variable: "AUTH_SECRET",
      severity: "fatal",
      message:
        "AUTH_SECRET is not set. src/lib/auth.ts only discovers this when something first needs it — " +
        "a sign-in, a capture-token check, a newsletter tick — so an unset secret lets the box boot and " +
        "serve pages for hours before failing on whoever happens to trigger it first. Set it to a long " +
        'random string before starting: `openssl rand -base64 32`, pasted as AUTH_SECRET="...".',
    });
    return;
  }
  pushIfPlaceholderOrShort(
    findings,
    "AUTH_SECRET",
    raw,
    () =>
      "AUTH_SECRET is still \"change-me-to-a-long-random-string\", the placeholder .env.example ships. " +
      "That string is public in this repository, so it signs sessions' tokens, capture tokens and " +
      "unsubscribe links with a key anyone who has read the source already has. Replace it with " +
      "`openssl rand -base64 32` before this box is reachable from anywhere but your own machine.",
    (length) =>
      `AUTH_SECRET is only ${length} characters, which is short enough to guess or brute-force outright. ` +
      "Replace it with something like `openssl rand -base64 32` (44 characters).",
  );
}

function checkAppUrl(env: NodeJS.ProcessEnv, findings: StartupFinding[]): void {
  const raw = env.APP_URL?.trim() ?? "";
  if (!raw) {
    findings.push({
      variable: "APP_URL",
      severity: "fatal",
      message:
        "APP_URL is not set. Every emailed link (password reset, invitation, weekly digest, unsubscribe) " +
        "needs an absolute URL to point at, since mail is read away from any request this app could infer " +
        "an origin from (§9b). Set it to this box's externally reachable https URL, e.g. " +
        'APP_URL="https://box.your-tailnet.ts.net" (§10).',
    });
    return;
  }

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    findings.push({
      variable: "APP_URL",
      severity: "fatal",
      message: `APP_URL="${raw}" does not parse as a URL. It needs a scheme and a host, e.g. https://box.your-tailnet.ts.net.`,
    });
    return;
  }

  // Decision: fatal, not a warning, and deliberately the same condition the
  // security-headers work gates HSTS on. Emailed links carry the tokens that
  // stand in for a password (reset, invitation, unsubscribe) — the exact
  // things HTTPS-only cookies and HSTS exist to protect — and the Phase 6
  // exposure gate (REMAINING_MULTI_HOUSEHOLD_PLAN.md) already refuses public
  // ingress until HTTPS terminates somewhere trusted. A production APP_URL
  // that isn't https means either that gate hasn't been met yet, or a
  // same-origin mismatch that would send mail linking to the wrong scheme
  // entirely; neither is a state worth letting the process boot into.
  if (url.protocol !== "https:") {
    findings.push({
      variable: "APP_URL",
      severity: "fatal",
      message:
        `APP_URL="${raw}" is not https. Emailed links (password reset, invitations, unsubscribe) would ` +
        "carry their one-time tokens in plain text, and the security headers only send HSTS when this is " +
        'https. Use the https MagicDNS name, e.g. APP_URL="https://box.your-tailnet.ts.net" (§10), or the ' +
        "https name of whatever terminates TLS in front of this box.",
    });
  }
}

function checkDatabaseUrl(env: NodeJS.ProcessEnv, findings: StartupFinding[]): void {
  const raw = env.DATABASE_URL?.trim() ?? "";
  if (!raw) {
    findings.push({
      variable: "DATABASE_URL",
      severity: "fatal",
      message:
        "DATABASE_URL is not set. Prisma has no database to connect to. Set it to the Postgres connection " +
        'string, e.g. DATABASE_URL="postgresql://user:password@host:5432/db?schema=public".',
    });
    return;
  }

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    findings.push({
      variable: "DATABASE_URL",
      severity: "fatal",
      message: `DATABASE_URL="${raw}" does not parse as a connection string. Expected postgresql://user:password@host:port/database.`,
    });
    return;
  }

  // Decision: fatal, not a warning. docker-compose.yml defaults POSTGRES_USER
  // and POSTGRES_PASSWORD to "mealplanner" so a first `docker compose up`
  // works with no setup — right for a box that only ever spoke to itself over
  // Tailscale, wrong the moment Phase 6's exposure gate opens this to the
  // public internet: default credentials on the database holding every
  // recipe, plan and receipt photo in the household are a published fact,
  // not a secret. The alternative — a warning — would let an installation
  // stay on them indefinitely, since nothing else here would ever revisit the
  // decision. Weighed against the cost (one restart, after changing
  // POSTGRES_PASSWORD and DATABASE_URL together), shipping default database
  // credentials to the internet is the worse failure, so this refuses to
  // start rather than merely log.
  const user = decodeURIComponent(url.username);
  const password = decodeURIComponent(url.password);
  if (user === EXAMPLE_DB_USER && password === EXAMPLE_DB_PASSWORD) {
    findings.push({
      variable: "DATABASE_URL",
      severity: "fatal",
      message:
        `DATABASE_URL is still using the example "${EXAMPLE_DB_USER}"/"${EXAMPLE_DB_PASSWORD}" credentials ` +
        "from .env.example and docker-compose.yml's defaults. Set POSTGRES_USER and POSTGRES_PASSWORD (and, " +
        "if you assemble DATABASE_URL yourself rather than letting compose do it, DATABASE_URL to match) to " +
        "a real password before this box is reachable from anywhere but your own tailnet.",
    });
  }
}

function checkCronSecret(env: NodeJS.ProcessEnv, findings: StartupFinding[]): void {
  const raw = env.CRON_SECRET?.trim() ?? "";
  // Decision: absent is not a finding at all. bearerTokenMatches (src/lib/
  // auth.ts) refuses every bearer token when the configured secret is empty,
  // so an unset CRON_SECRET simply closes POST /api/backup/run and POST
  // /api/newsletter/send — the same "fails closed" property AUTH_SECRET's
  // *lazy* check doesn't have, and exactly why AUTH_SECRET gets a finding
  // here while this doesn't. Flagging a missing CRON_SECRET would train
  // whoever reads this output to set one out of habit, which only recreates
  // the placeholder problem below.
  if (!raw) return;

  pushIfPlaceholderOrShort(
    findings,
    "CRON_SECRET",
    raw,
    () =>
      "CRON_SECRET is still \"change-me-to-a-long-random-string\", the placeholder .env.example ships, " +
      "which is public in this repository. Anyone who has read the source can present it as a bearer " +
      "token and trigger POST /api/backup/run or POST /api/newsletter/send. Set a real value with " +
      "`openssl rand -base64 32`, or unset CRON_SECRET entirely to close both endpoints (§9c).",
    (length) =>
      `CRON_SECRET is only ${length} characters, short enough to be worth guessing outright. Replace it ` +
      "with `openssl rand -base64 32`, or unset it entirely to close the endpoints it guards (§9c).",
  );
}

function checkBorgPassphrase(env: NodeJS.ProcessEnv, findings: StartupFinding[]): void {
  const repo = env.BORG_REPO?.trim() ?? "";
  const passphrase = env.BORG_PASSPHRASE ?? "";

  // Decision: an unconfigured backup is not this check's business. §11 calls
  // backups non-optional, but making that true is a scope change this task
  // explicitly isn't — src/instrumentation.ts's backup scheduler already logs
  // "not configured (...); nothing is being backed up" on every boot, loudly
  // and truthfully, which is the right amount of alarm for a feature that is
  // allowed to be off. This function only has something to say once BORG_REPO
  // is actually set: a passphrase problem is only real on a repository
  // somebody meant to use.
  if (!repo || !passphrase) return;

  pushIfPlaceholderOrShort(
    findings,
    "BORG_PASSPHRASE",
    passphrase,
    () =>
      "BORG_PASSPHRASE is still \"change-me-to-a-long-random-string\" on a configured repository " +
      "(BORG_REPO is set) — and that placeholder is public in this repository. Every archive would be " +
      "encrypted with a passphrase anyone reading the source already has, which is no better than no " +
      "encryption at all. Generate a real one (the backup settings screen can do this for you) before " +
      "the next backup runs — and write down whatever you replace it with somewhere off this box; " +
      "changing it doesn't re-encrypt archives already written under the old one (§11).",
    (length) =>
      `BORG_PASSPHRASE is only ${length} characters on a configured repository (BORG_REPO is set), short ` +
      "enough to be worth guessing outright against a stolen archive. Generate a real one from the backup " +
      "settings screen, and write it down somewhere off this box (§11).",
  );
}

/**
 * Every startup finding, computed the same way regardless of environment.
 *
 * Takes a plain environment object rather than reading `process.env` itself
 * so tests can hand it fabricated `.env`s without mutating the real one out
 * from under whatever else is running in the same test process.
 */
export function findStartupProblems(env: NodeJS.ProcessEnv): StartupFinding[] {
  const findings: StartupFinding[] = [];
  checkAuthSecret(env, findings);
  checkAppUrl(env, findings);
  checkDatabaseUrl(env, findings);
  checkCronSecret(env, findings);
  checkBorgPassphrase(env, findings);
  return findings;
}

/**
 * `findStartupProblems`, plus the one decision that depends on which
 * environment this is: whether any of it should refuse to start.
 *
 * `npm run dev` and `npm test` (and `next build`, which sets NODE_ENV to
 * "production" while it prerenders — see the NEXT_PHASE guard in
 * instrumentation.ts) must stay usable with a half-configured `.env`; a
 * running production container must not. Both read the same findings —
 * nothing here is checked differently depending on NODE_ENV — only whether a
 * "fatal" finding actually blocks changes.
 */
export function checkStartupConfig(env: NodeJS.ProcessEnv): StartupCheck {
  const findings = findStartupProblems(env);
  const production = env.NODE_ENV === "production";
  return {
    findings,
    blocking: production ? findings.filter((f) => f.severity === "fatal") : [],
  };
}
