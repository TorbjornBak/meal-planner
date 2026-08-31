-- A browser session carries the household it is acting in. Ownership remains
-- on the membership row, and the composite foreign key prevents selecting a
-- household the session's user has not joined.

-- AlterTable
ALTER TABLE "Session" ADD COLUMN "activeHouseholdId" TEXT;

-- Backfill every existing session with its user's oldest membership. Phase 1
-- assigned all existing users to the initial household, while nullable keeps
-- this migration compatible with pending accounts during the invitation
-- transition.
UPDATE "Session" AS s
SET "activeHouseholdId" = (
    SELECT m."householdId"
    FROM "HouseholdMembership" AS m
    WHERE m."userId" = s."userId"
    ORDER BY m."createdAt" ASC, m."householdId" ASC
    LIMIT 1
)
WHERE s."activeHouseholdId" IS NULL;

-- CreateIndex
CREATE INDEX "Session_activeHouseholdId_userId_idx" ON "Session"("activeHouseholdId", "userId");

-- AddForeignKey
ALTER TABLE "Session"
ADD CONSTRAINT "Session_activeHouseholdId_userId_fkey"
FOREIGN KEY ("activeHouseholdId", "userId")
REFERENCES "HouseholdMembership"("householdId", "userId")
ON DELETE CASCADE ON UPDATE CASCADE;
