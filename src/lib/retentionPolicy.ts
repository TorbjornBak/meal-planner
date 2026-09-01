/**
 * When a dead credential stops being worth keeping (§9, Phase 6).
 *
 * Pure, and separate from src/lib/retention.ts for the reason
 * src/lib/rateLimitPolicy.ts is separate from src/lib/rateLimit.ts: the part
 * that can be wrong in a damaging way is the arithmetic, and it should not
 * need a database to check. A cutoff computed in the wrong direction deletes
 * live sessions instead of expired ones, and the way that reports itself is
 * every member being signed out at once rather than an error anybody can read.
 *
 * The deletes themselves are next door.
 */

/**
 * How long a spent or expired emailed link is kept before deletion.
 *
 * Not zero, and the reason is support rather than security: the row is dead as
 * a credential the instant it is used, but "was a reset link actually issued
 * and used for this account last Tuesday?" is a question somebody asks a week
 * later when an account has behaved oddly. A month is long enough to answer it
 * and short enough that the table does not become a permanent record of
 * everyone who has ever forgotten a password.
 */
export const SPENT_TOKEN_GRACE_MS = 30 * 24 * 60 * 60 * 1000;

export interface RetentionCutoffs {
  /** Sessions and tokens whose expiry has already passed. */
  expiredBefore: Date;
  /** Spent links older than the grace period. */
  spentBefore: Date;
}

/**
 * The cutoffs a sweep at `now` should use.
 *
 * `expiredBefore` is exactly `now` rather than a moment either side of it: a
 * row expiring a second ago is dead and collectable, and a row expiring a
 * second from now is still a working credential. There is no safety margin to
 * add here, and adding one in the wrong direction is how a sweep starts
 * signing people out.
 */
export function retentionCutoffs(now: Date): RetentionCutoffs {
  return {
    expiredBefore: now,
    spentBefore: new Date(now.getTime() - SPENT_TOKEN_GRACE_MS),
  };
}

export interface SweepReport {
  sessions: number;
  authTokens: number;
  rateLimitCounters: number;
}

/** Whether a sweep found anything worth a log line. */
export function sweptAnything(report: SweepReport): boolean {
  return report.sessions + report.authTokens + report.rateLimitCounters > 0;
}
