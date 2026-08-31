-- The record of what somebody operating the installation did to a household
-- they are not a member of.
--
-- Phase 5 gives a platform admin two powers no household member has: inviting
-- somebody to start a household, and reaching into an existing household's
-- membership to break a deadlock or restore a lost admin. Both are necessary —
-- admins are equals and cannot remove one another, so a household that has
-- fallen out or lost its last admin cannot fix itself — and both are exactly
-- the kind of act that must leave a trace.

-- CreateEnum
CREATE TYPE "AuditAction" AS ENUM (
    'PLATFORM_INVITATION_SENT',
    'PLATFORM_INVITATION_REVOKED',
    'HOUSEHOLD_ROLE_CHANGED',
    'HOUSEHOLD_MEMBER_REMOVED',
    'SMTP_TEST_SENT',
    'BACKUP_INITIALISED',
    'BACKUP_RUN_REQUESTED'
);

-- CreateTable
CREATE TABLE "AuditEvent" (
    "id" TEXT NOT NULL,
    "action" "AuditAction" NOT NULL,
    "actorId" TEXT,
    "actorEmail" TEXT,
    "householdId" TEXT,
    "householdName" TEXT,
    "subjectEmail" TEXT,
    "detail" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AuditEvent_createdAt_idx" ON "AuditEvent"("createdAt");
CREATE INDEX "AuditEvent_householdId_idx" ON "AuditEvent"("householdId");
CREATE INDEX "AuditEvent_actorId_idx" ON "AuditEvent"("actorId");

-- Both references null out rather than cascade. The snapshot columns beside
-- them (actorEmail, householdName, subjectEmail) are what the record is
-- actually made of: deleting an account or winding up a household must not
-- quietly delete the evidence of what was done to it, and the moment anybody
-- wants to read this table is precisely the moment somebody has been removed.
ALTER TABLE "AuditEvent"
ADD CONSTRAINT "AuditEvent_actorId_fkey"
FOREIGN KEY ("actorId") REFERENCES "User"("id")
ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "AuditEvent"
ADD CONSTRAINT "AuditEvent_householdId_fkey"
FOREIGN KEY ("householdId") REFERENCES "Household"("id")
ON DELETE SET NULL ON UPDATE CASCADE;
