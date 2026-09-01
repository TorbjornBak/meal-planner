-- Two things the app needs before it can be reached from outside the tailnet
-- (§9, Phase 6): somewhere to count attempts, and a wider vocabulary for the
-- record of what was done.

-- --------------------------------------------------------------------------
-- Rate limiting
-- --------------------------------------------------------------------------
--
-- A table rather than a map in the process. The limit has to outlive the thing
-- it protects against: a guessing script that can wait out a deploy — and this
-- app restarts on every push — beats an in-memory counter without noticing it
-- was there. It also makes the limit one limit rather than one per worker.
--
-- `subject` holds a SHA-256, never the value. The two things this table is
-- keyed by are precisely the two worth not writing down: the address somebody
-- is sitting behind, and the email they typed into a login form, including the
-- ones that turned out not to exist. A hash counts exactly as well.
CREATE TABLE "RateLimitCounter" (
    "id" TEXT NOT NULL,
    "bucket" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "windowStart" TIMESTAMP(3) NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 0,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RateLimitCounter_pkey" PRIMARY KEY ("id")
);

-- The window start is part of the key, not a column that gets rewritten, so
-- rolling into a new window is an insert. That is what makes the whole
-- increment expressible as one upsert with no read first, and therefore safe
-- against two requests arriving together.
CREATE UNIQUE INDEX "RateLimitCounter_bucket_subject_windowStart_key"
    ON "RateLimitCounter"("bucket", "subject", "windowStart");

-- Expired rows are swept opportunistically by the limiter rather than by a
-- scheduler; this is the index that makes the sweep cheap.
CREATE INDEX "RateLimitCounter_expiresAt_idx" ON "RateLimitCounter"("expiresAt");

-- --------------------------------------------------------------------------
-- A wider audit vocabulary
-- --------------------------------------------------------------------------
--
-- Phase 5 recorded what a platform admin did to a household they were not a
-- member of. Phase 6 keeps that and adds the acts that matter once anybody on
-- the internet can reach the login form: invitations at household level,
-- memberships appearing as well as disappearing, credential changes, and the
-- moment the rate limiter starts refusing somebody.
--
-- Postgres will not let a value added to an enum be used in the same
-- transaction that adds it, and prisma migrate runs each file in one. Nothing
-- here writes a row, so that is fine — but it is why this file only declares.
ALTER TYPE "AuditAction" ADD VALUE 'HOUSEHOLD_INVITATION_SENT';
ALTER TYPE "AuditAction" ADD VALUE 'HOUSEHOLD_INVITATION_REVOKED';
ALTER TYPE "AuditAction" ADD VALUE 'INVITATION_ACCEPTED';
ALTER TYPE "AuditAction" ADD VALUE 'HOUSEHOLD_MEMBER_JOINED';
ALTER TYPE "AuditAction" ADD VALUE 'PASSWORD_CHANGED';
ALTER TYPE "AuditAction" ADD VALUE 'PASSWORD_RESET_REQUESTED';
ALTER TYPE "AuditAction" ADD VALUE 'PASSWORD_RESET_COMPLETED';
ALTER TYPE "AuditAction" ADD VALUE 'AUTH_THROTTLED';
ALTER TYPE "AuditAction" ADD VALUE 'BACKUP_KEY_ACCESSED';
