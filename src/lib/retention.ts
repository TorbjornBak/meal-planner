/**
 * Deleting the credentials that have stopped meaning anything (§9, Phase 6).
 *
 * Three tables accumulate rows that are dead but not gone, and every one of
 * them accumulates fastest under exactly the conditions this phase is
 * preparing for — a box anybody can reach, being knocked on by people who are
 * not household members.
 *
 * `Session` rows expire, but src/lib/auth.ts only notices when somebody
 * presents that cookie: `resolveSession` deletes the row it was asked about.
 * A session nobody ever returns to — a browser closed for good, a phone
 * replaced — is never asked about again, so its row sits there permanently.
 * The rows are individually harmless and collectively a list of everyone who
 * has ever signed in, which is not a list worth keeping forever.
 *
 * `AuthToken` rows are worse in one specific way: a *used* reset token is
 * deleted by nothing at all today. `issueAuthToken` clears unused tokens of
 * the same purpose when a new one is minted, so the live set stays at one —
 * but redeemed ones and expired-unredeemed ones both simply stay.
 *
 * `RateLimitCounter` is already swept opportunistically by the limiter itself
 * (src/lib/rateLimit.ts sweeps on roughly one call in fifty). That works while
 * traffic continues and stops working the moment it doesn't, which is the case
 * that matters: an attack ends, the counters it created stop being touched,
 * and nothing left running ever revisits them. A scheduled sweep closes that.
 *
 * What is deliberately *not* swept: `AuditEvent`, which is the record Phase 5
 * and 6 exist to create and whose whole value is that it outlives the thing it
 * describes; `NewsletterSend`, which is the idempotency key that stops a
 * household being mailed the same digest twice; and `Invitation`, which is
 * kept after acceptance or revocation on purpose (see its doc comment in
 * prisma/schema.prisma) because who was invited where, by whom, and what
 * became of it is itself part of the trail.
 */

import { prisma } from "@/lib/prisma";
import {
  type SweepReport,
  retentionCutoffs,
} from "@/lib/retentionPolicy";

export { SPENT_TOKEN_GRACE_MS, sweptAnything } from "@/lib/retentionPolicy";
export type { SweepReport } from "@/lib/retentionPolicy";

/**
 * Delete what has stopped meaning anything, and say how much went.
 *
 * Every delete is keyed on an indexed timestamp column, and the conditions are
 * written so that a row is only ever removed once it can no longer authorise
 * anything: an expired session cannot be resumed, an expired token cannot be
 * redeemed, and a used one has already been. Nothing here deletes a row that
 * some request could still legitimately present.
 */
export async function sweepExpiredCredentials(now = new Date()): Promise<SweepReport> {
  const { expiredBefore, spentBefore } = retentionCutoffs(now);

  const [sessions, authTokens, rateLimitCounters] = await Promise.all([
    prisma.session.deleteMany({ where: { expiresAt: { lt: expiredBefore } } }),
    prisma.authToken.deleteMany({
      where: {
        OR: [
          // Expired without ever being spent: dead, and nothing will ever ask.
          { expiresAt: { lt: expiredBefore }, usedAt: null },
          // Spent, and past the window in which anybody would ask about it.
          { usedAt: { lt: spentBefore } },
        ],
      },
    }),
    prisma.rateLimitCounter.deleteMany({ where: { expiresAt: { lt: expiredBefore } } }),
  ]);

  return {
    sessions: sessions.count,
    authTokens: authTokens.count,
    rateLimitCounters: rateLimitCounters.count,
  };
}
