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
 * Every finding here is fatal in production, and is computed the same way in
 * every environment. It is instrumentation.ts — not this module — that decides,
 * based on NODE_ENV, whether a finding actually blocks the process or is merely
 * printed. That split is what makes
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

export interface StartupFinding {
  /** The environment variable this finding is about. */
  variable: string;
  severity: "fatal";
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
const EXAMPLE_APP_URL = "https://mealplanner.example.com";

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
        'APP_URL="https://mealplanner.example.com".',
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
      message: `APP_URL="${raw}" does not parse as a URL. It needs a scheme and a host, e.g. https://mealplanner.example.com.`,
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
        'https. Use the public https hostname, e.g. APP_URL="https://mealplanner.example.com", or the ' +
      "https name of whatever terminates TLS in front of this box.",
    });
    return;
  }

  if (url.toString().replace(/\/$/, "") === EXAMPLE_APP_URL) {
    findings.push({
      variable: "APP_URL",
      severity: "fatal",
      message:
        `APP_URL is still the example value "${EXAMPLE_APP_URL}" from .env.example. ` +
        "Replace it with this installation's real HTTPS hostname before starting production.",
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
  // works with no setup — useful for local development, but wrong once the
  // application is exposed to the
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
  if (!user || !password) {
    findings.push({
      variable: "DATABASE_URL",
      severity: "fatal",
      message:
        "DATABASE_URL must include both a username and password. Use a dedicated database account with " +
        "a non-example password before starting production.",
    });
  } else if (user === EXAMPLE_DB_USER || password === EXAMPLE_DB_PASSWORD) {
    findings.push({
      variable: "DATABASE_URL",
      severity: "fatal",
      message:
        `DATABASE_URL is still using the example "${EXAMPLE_DB_USER}"/"${EXAMPLE_DB_PASSWORD}" credentials ` +
        "from .env.example and docker-compose.yml's defaults. Set POSTGRES_USER and POSTGRES_PASSWORD (and, " +
        "if you assemble DATABASE_URL yourself rather than letting compose do it, DATABASE_URL to match) to " +
        "a real password before this box is reachable from the public internet.",
    });
  }
}

function checkCronSecret(env: NodeJS.ProcessEnv, findings: StartupFinding[]): void {
  const raw = env.CRON_SECRET?.trim() ?? "";
  if (!raw) {
    findings.push({
      variable: "CRON_SECRET",
      severity: "fatal",
      message:
        "CRON_SECRET is not set. Production requires a strong bearer secret for scheduled newsletter " +
        'and backup requests; generate one with `openssl rand -base64 32`.',
    });
    return;
  }

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

/**
 * Whether the backup configuration is *coherent* — not whether it exists.
 *
 * Running without backups is a supported way to run this app, and everything
 * else already says so: the scheduler in src/instrumentation.ts logs "not
 * configured … nothing is being backed up" and idles, and the settings screen
 * says it in plainer words than a log line could. This check used to disagree
 * and refuse to start at all, which made an unconfigured box impossible to
 * boot rather than merely unbacked-up — a strictly worse outcome, since a box
 * that will not start has no data to lose and no way to be given any. Wanting
 * backups is a judgement about how much the data is worth, and that judgement
 * belongs to whoever runs the box, not to this file.
 *
 * What is *not* a judgement call is a repository configured with a passphrase
 * that cannot protect it. So the rule turns on BORG_REPO: with no repository
 * there is nothing to get wrong and nothing is said, and once a repository is
 * named the passphrase guarding it must be real — present, not the public
 * placeholder, and long enough to be worth having. A passphrase set with no
 * repository is inert and left alone; it is somebody halfway through
 * configuring backups, not a mistake.
 */
function checkBorgPassphrase(env: NodeJS.ProcessEnv, findings: StartupFinding[]): void {
  const repo = env.BORG_REPO?.trim() ?? "";
  const passphrase = env.BORG_PASSPHRASE ?? "";

  // No repository named: backups are off, which is a choice, not a fault.
  if (!repo) return;

  if (!passphrase) {
    findings.push({
      variable: "BORG_PASSPHRASE",
      severity: "fatal",
      message:
        "BORG_PASSPHRASE is not set on a configured repository (BORG_REPO is set). Generate a strong " +
        "passphrase, store a copy off the box, and configure it — or unset BORG_REPO to run without " +
        "backups.",
    });
    return;
  }

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
