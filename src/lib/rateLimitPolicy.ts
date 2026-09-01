/**
 * How hard somebody may knock, and who counts as somebody (§9, Phase 6).
 *
 * Pure, and separate from src/lib/rateLimit.ts for the same reason
 * platformAdmin.ts is separate from the routes that call it: the interesting
 * part of a rate limit is the arithmetic and the table of numbers, and neither
 * should need a database and a running server to check. Everything here is a
 * total function of its arguments, so src/lib/rateLimitPolicy.test.mjs can
 * exercise the whole table — including the boundaries, which are where fixed
 * windows are actually wrong — in microseconds.
 *
 * The counting itself, which needs Postgres, is next door.
 */

/** One limit: how many attempts, over how long. */
export interface Limit {
  max: number;
  windowMs: number;
}

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;

/**
 * Every limit the app enforces, in one table.
 *
 * Two kinds of key, and both are needed. Keying only by IP lets one address be
 * ground down from a botnet; keying only by account lets somebody lock a
 * neighbour out of their own login by failing on purpose, and lets a single
 * host walk an address list one guess apiece. So the sensitive endpoints count
 * both, and refuse when either is exhausted.
 *
 * The numbers are set where a person who has genuinely forgotten something
 * never meets them. Ten sign-in attempts a quarter of an hour is more than
 * anybody types before reaching for the reset link; three reset mails an hour
 * to one address is more than anybody sends before checking their spam folder.
 * They are not set to stop a determined attacker outright — scrypt and a
 * 256-bit token do that — but to make an online guessing run cost more than it
 * can possibly be worth, and to keep this installation's SMTP relay from being
 * turned into somebody else's mail cannon.
 */
export const LIMITS = {
  /**
   * Sign-in. The email key is deliberately the tighter of the two: an attacker
   * with one target and many hosts is the case a per-IP limit alone misses.
   */
  "login:ip": { max: 10, windowMs: 15 * MINUTE },
  "login:email": { max: 5, windowMs: 15 * MINUTE },

  /**
   * Forgot-password. This one sends mail to an address the caller chose, so
   * the limit is protecting the mailbox owner and the relay's reputation as
   * much as the account.
   */
  "password-forgot:ip": { max: 5, windowMs: HOUR },
  "password-forgot:email": { max: 3, windowMs: HOUR },

  /**
   * Spending a reset link. The token is 256 bits, so this is not really about
   * guessing it; it is about not letting a scripted caller hammer the endpoint
   * that writes password hashes.
   */
  "password-reset:ip": { max: 10, windowMs: HOUR },

  /**
   * Opening an invitation link, and spending one. Inspection is the looser of
   * the two because a person who forwards themselves the mail and taps it
   * twice on two devices is ordinary, whereas acceptance is the act that
   * creates an account.
   */
  "invitation:inspect:ip": { max: 20, windowMs: HOUR },
  "invitation:accept:ip": { max: 10, windowMs: HOUR },
  "invitation:accept:email": { max: 5, windowMs: HOUR },

  /**
   * Issuing invitations, keyed by the signed-in admin who asked. Authenticated,
   * so this is not an anti-guessing measure — it is a ceiling on how much mail
   * one account can make this box send, whether the account is being careless
   * or has been taken over.
   */
  "invitation:issue:user": { max: 20, windowMs: HOUR },

  /** Proving the SMTP relay works. One button, pressed by one admin. */
  "mail-test:user": { max: 5, windowMs: HOUR },

  /**
   * First-run bootstrap. Open by definition until an account exists, and shut
   * permanently afterwards, so the only window in which it can be abused is
   * between deployment and the first sign-up — but that window is real.
   */
  "setup:ip": { max: 5, windowMs: HOUR },

  /**
   * Changing a password while signed in. Keyed by the account, and generous:
   * this exists so a stolen session cannot be used to grind the current
   * password out of the "old password" field.
   */
  "password-change:user": { max: 10, windowMs: HOUR },
} as const satisfies Record<string, Limit>;

export type LimitName = keyof typeof LIMITS;

/**
 * The start of the fixed window `now` falls in.
 *
 * Anchored to the epoch rather than to first contact, so the window is a
 * property of the clock and not of whoever knocked first. That is what lets
 * the counter be keyed by (bucket, subject, windowStart) and incremented with
 * a single upsert: two requests arriving together compute the same window and
 * therefore contend on one row, instead of each inventing its own.
 */
export function windowStartAt(now: number, windowMs: number): Date {
  return new Date(Math.floor(now / windowMs) * windowMs);
}

/** When a window's row stops meaning anything and may be swept. */
export function windowExpiresAt(windowStart: Date, windowMs: number): Date {
  return new Date(windowStart.getTime() + windowMs);
}

export interface Verdict {
  allowed: boolean;
  /** Attempts left after this one; zero once the limit is reached. */
  remaining: number;
  /** How long until the window rolls over. Whole seconds, at least one. */
  retryAfterSeconds: number;
}

/**
 * Whether the attempt that produced `count` is allowed.
 *
 * `count` is the value *after* the increment, so the first attempt in a window
 * arrives here as 1 and a limit of 5 admits counts 1 through 5. Deciding after
 * incrementing rather than before is what makes the whole check one round trip
 * and immune to two requests both reading four and both proceeding.
 */
export function decide(count: number, limit: Limit, now: number, windowStart: Date): Verdict {
  const endsAt = windowStart.getTime() + limit.windowMs;
  return {
    allowed: count <= limit.max,
    remaining: Math.max(0, limit.max - count),
    // Never zero: a Retry-After of 0 invites an immediate retry, which is the
    // one thing this header exists to prevent.
    retryAfterSeconds: Math.max(1, Math.ceil((endsAt - now) / 1000)),
  };
}

/**
 * The caller's address, as far as this installation can honestly tell.
 *
 * `X-Forwarded-For` is a list that each hop appends to, so its leftmost entry
 * is whatever the client claimed and is worth nothing — a header anybody can
 * write. The *rightmost* entry is the one appended by the hop nearest us,
 * which for this deployment is the single trusted terminator in front of the
 * app (`tailscale serve`, or the Caddy that fronts the public name), and is
 * therefore the last value an outsider cannot forge.
 *
 * That reasoning holds only for exactly one trusted hop. Putting a second
 * proxy in front of this app without revisiting this function would make the
 * rightmost entry that proxy's own address, and collapse every caller in the
 * world into one rate-limit bucket — which fails closed, loudly, rather than
 * quietly opening the limit up, and is the direction to be wrong in.
 *
 * Returning null when there is no usable address is deliberate; the caller
 * decides what an unattributable request means, and for every route here it
 * means "count it against a shared bucket", not "skip the limit".
 */
export function clientIp(headers: { get(name: string): string | null }): string | null {
  const forwarded = headers.get("x-forwarded-for");
  if (forwarded) {
    const hops = forwarded
      .split(",")
      .map((hop) => hop.trim())
      .filter(Boolean);
    const nearest = hops[hops.length - 1];
    if (nearest) return normalizeIp(nearest);
  }

  const real = headers.get("x-real-ip")?.trim();
  if (real) return normalizeIp(real);

  return null;
}

/**
 * Fold the spellings of one address together, so a limit cannot be reset by
 * changing how the address is written.
 *
 * IPv6 arrives bracketed from some proxies and bare from others, addresses may
 * carry a source port, and an IPv4 address tunnelled through IPv6 shows up as
 * `::ffff:1.2.3.4`. Three spellings of one host would otherwise be three
 * buckets.
 */
function normalizeIp(raw: string): string {
  let value = raw.toLowerCase();

  // "[2001:db8::1]:443" or "[2001:db8::1]"
  const bracketed = value.match(/^\[([^\]]+)\](?::\d+)?$/);
  if (bracketed) value = bracketed[1];
  // "1.2.3.4:443" — only ever IPv4, since a bare IPv6 is full of colons.
  else if (/^\d{1,3}(\.\d{1,3}){3}:\d+$/.test(value)) value = value.split(":")[0];

  if (value.startsWith("::ffff:")) value = value.slice("::ffff:".length);

  return value;
}
