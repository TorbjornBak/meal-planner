-- Backups the app takes itself, and can be asked about (§11).
--
-- Backups were a shell script in the host's crontab, which is the arrangement
-- §9b already threw out for the weekly digest: unversioned, missing from a
-- rebuilt box, and silent when its command is wrong. It is a worse arrangement
-- for backups than it was for mail. A digest that stops arriving is noticed by
-- five people on Friday; a backup that stops running is noticed once, on the
-- day the disk dies.
--
-- So the app takes them, and writes down what happened. The schedule reads
-- these rows to decide whether tonight's backup is still owed — which is what
-- makes a fifteen-minute tick take one archive a night instead of ninety, and
-- what lets a box that was off at three catch up when it comes back. The
-- settings screen reads them so a household can see the answer to "are we
-- actually backed up?" without a terminal.
--
-- Failures are rows as much as successes are: an attempt that failed is the
-- thing most worth keeping, and its absence is what made the crontab version
-- so quiet.
--
-- Nothing to backfill. An instance upgrading to this has no history of runs
-- the app took, because it never took any.

-- CreateEnum
CREATE TYPE "BackupTrigger" AS ENUM ('SCHEDULED', 'MANUAL');

-- CreateTable
CREATE TABLE "BackupRun" (
    "id" TEXT NOT NULL,
    "day" DATE NOT NULL,
    "trigger" "BackupTrigger" NOT NULL DEFAULT 'SCHEDULED',
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "ok" BOOLEAN NOT NULL DEFAULT false,
    "archive" TEXT,
    "originalBytes" BIGINT,
    "compressedBytes" BIGINT,
    "dedupedBytes" BIGINT,
    "error" TEXT,
    "warnings" TEXT,

    CONSTRAINT "BackupRun_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
-- The scheduler's question every quarter hour: has the owed day got a run yet?
CREATE INDEX "BackupRun_day_idx" ON "BackupRun"("day");

-- CreateIndex
-- The settings screen's question: what happened lately?
CREATE INDEX "BackupRun_startedAt_idx" ON "BackupRun"("startedAt");

-- No unique constraint on "day": backing up by hand twice in an afternoon is
-- allowed, and the scheduled run's idempotence comes from asking whether the
-- owed day already has a *successful* row.
