-- Contract the Phase 1 expand/backfill migration after every application
-- caller has learned to supply and filter by household ownership.

-- Any rows written by the old application between the Phase 1 and Phase 3
-- deployments still belong to the only household that application knew.
UPDATE "Recipe" SET "householdId" = 'initial-household' WHERE "householdId" IS NULL;
UPDATE "WeekPlan" SET "householdId" = 'initial-household' WHERE "householdId" IS NULL;
UPDATE "PantryItem" SET "householdId" = 'initial-household' WHERE "householdId" IS NULL;
UPDATE "ShoppingTrip" SET "householdId" = 'initial-household' WHERE "householdId" IS NULL;
UPDATE "NewsletterSend" SET "householdId" = 'initial-household' WHERE "householdId" IS NULL;
UPDATE "Settings" SET "householdId" = 'initial-household' WHERE "householdId" IS NULL;

-- DinnerSlot connects two aggregate roots. Carrying householdId on the join
-- lets composite foreign keys prove that both the plan and recipe belong to
-- the same household, even if an application check is accidentally omitted.
ALTER TABLE "DinnerSlot" ADD COLUMN "householdId" TEXT;
UPDATE "DinnerSlot" AS slot
SET "householdId" = plan."householdId"
FROM "WeekPlan" AS plan
WHERE plan."id" = slot."weekPlanId";

DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM "Recipe" WHERE "householdId" IS NULL
        UNION ALL SELECT 1 FROM "WeekPlan" WHERE "householdId" IS NULL
        UNION ALL SELECT 1 FROM "PantryItem" WHERE "householdId" IS NULL
        UNION ALL SELECT 1 FROM "ShoppingTrip" WHERE "householdId" IS NULL
        UNION ALL SELECT 1 FROM "NewsletterSend" WHERE "householdId" IS NULL
        UNION ALL SELECT 1 FROM "Settings" WHERE "householdId" IS NULL
        UNION ALL SELECT 1 FROM "DinnerSlot" WHERE "householdId" IS NULL
    ) THEN
        RAISE EXCEPTION 'cannot enforce household isolation while unowned rows remain';
    END IF;

    IF EXISTS (
        SELECT 1
        FROM "DinnerSlot" slot
        JOIN "Recipe" recipe ON recipe."id" = slot."recipeId"
        WHERE recipe."householdId" <> slot."householdId"
    ) THEN
        RAISE EXCEPTION 'a dinner slot links a plan to another household''s recipe';
    END IF;
END $$;

ALTER TABLE "Recipe" ALTER COLUMN "householdId" SET NOT NULL;
ALTER TABLE "WeekPlan" ALTER COLUMN "householdId" SET NOT NULL;
ALTER TABLE "PantryItem" ALTER COLUMN "householdId" SET NOT NULL;
ALTER TABLE "ShoppingTrip" ALTER COLUMN "householdId" SET NOT NULL;
ALTER TABLE "NewsletterSend" ALTER COLUMN "householdId" SET NOT NULL;
ALTER TABLE "Settings" ALTER COLUMN "householdId" SET NOT NULL;
ALTER TABLE "DinnerSlot" ALTER COLUMN "householdId" SET NOT NULL;

-- Household-scoped identities replace the single-household global identities.
DROP INDEX "WeekPlan_weekStart_key";
DROP INDEX "PantryItem_nameKey_key";
DROP INDEX "NewsletterSend_userId_weekStart_key";

-- Composite identities support the same-household DinnerSlot foreign keys.
CREATE UNIQUE INDEX "Recipe_id_householdId_key" ON "Recipe"("id", "householdId");
CREATE UNIQUE INDEX "WeekPlan_id_householdId_key" ON "WeekPlan"("id", "householdId");
CREATE INDEX "DinnerSlot_householdId_idx" ON "DinnerSlot"("householdId");

ALTER TABLE "DinnerSlot" DROP CONSTRAINT "DinnerSlot_weekPlanId_fkey";
ALTER TABLE "DinnerSlot" DROP CONSTRAINT "DinnerSlot_recipeId_fkey";

ALTER TABLE "DinnerSlot"
ADD CONSTRAINT "DinnerSlot_householdId_fkey"
FOREIGN KEY ("householdId") REFERENCES "Household"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "DinnerSlot"
ADD CONSTRAINT "DinnerSlot_weekPlanId_householdId_fkey"
FOREIGN KEY ("weekPlanId", "householdId")
REFERENCES "WeekPlan"("id", "householdId")
ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "DinnerSlot"
ADD CONSTRAINT "DinnerSlot_recipeId_householdId_fkey"
FOREIGN KEY ("recipeId", "householdId")
REFERENCES "Recipe"("id", "householdId")
ON DELETE CASCADE ON UPDATE CASCADE;
