-- Phase 1 of multi-household support is deliberately an expand/backfill
-- migration. Ownership remains nullable until every request is scoped; the
-- existing app can therefore keep writing during a rolling deployment.

-- CreateEnum
CREATE TYPE "PlatformRole" AS ENUM ('USER', 'ADMIN');

-- CreateEnum
CREATE TYPE "HouseholdRole" AS ENUM ('MEMBER', 'ADMIN');

-- CreateTable
CREATE TABLE "Household" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Household_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HouseholdMembership" (
    "householdId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "role" "HouseholdRole" NOT NULL DEFAULT 'MEMBER',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "HouseholdMembership_pkey" PRIMARY KEY ("householdId", "userId")
);

-- AlterTable
ALTER TABLE "User" ADD COLUMN "platformRole" "PlatformRole" NOT NULL DEFAULT 'USER';

-- AlterTable
ALTER TABLE "Recipe" ADD COLUMN "householdId" TEXT;

-- AlterTable
ALTER TABLE "WeekPlan" ADD COLUMN "householdId" TEXT;

-- AlterTable
ALTER TABLE "PantryItem" ADD COLUMN "householdId" TEXT;

-- AlterTable
ALTER TABLE "ShoppingTrip" ADD COLUMN "householdId" TEXT;

-- AlterTable
ALTER TABLE "NewsletterSend" ADD COLUMN "householdId" TEXT;

-- The former singleton Settings row keeps id=1, while the sequence prepares
-- the table for one row per household without breaking current callers.
CREATE SEQUENCE "Settings_id_seq";
ALTER TABLE "Settings" ALTER COLUMN "id" SET DEFAULT nextval('"Settings_id_seq"');
ALTER SEQUENCE "Settings_id_seq" OWNED BY "Settings"."id";
ALTER TABLE "Settings" ADD COLUMN "householdId" TEXT;

-- CreateIndex
CREATE INDEX "HouseholdMembership_userId_idx" ON "HouseholdMembership"("userId");

-- CreateIndex
CREATE INDEX "Recipe_householdId_idx" ON "Recipe"("householdId");

-- CreateIndex
CREATE INDEX "WeekPlan_householdId_idx" ON "WeekPlan"("householdId");

-- CreateIndex
CREATE UNIQUE INDEX "WeekPlan_householdId_weekStart_key" ON "WeekPlan"("householdId", "weekStart");

-- CreateIndex
CREATE INDEX "PantryItem_householdId_idx" ON "PantryItem"("householdId");

-- CreateIndex
CREATE UNIQUE INDEX "PantryItem_householdId_nameKey_key" ON "PantryItem"("householdId", "nameKey");

-- CreateIndex
CREATE INDEX "ShoppingTrip_householdId_idx" ON "ShoppingTrip"("householdId");

-- CreateIndex
CREATE INDEX "NewsletterSend_householdId_idx" ON "NewsletterSend"("householdId");

-- CreateIndex
CREATE UNIQUE INDEX "NewsletterSend_householdId_userId_weekStart_key" ON "NewsletterSend"("householdId", "userId", "weekStart");

-- CreateIndex
CREATE UNIQUE INDEX "Settings_householdId_key" ON "Settings"("householdId");

-- AddForeignKey
ALTER TABLE "HouseholdMembership" ADD CONSTRAINT "HouseholdMembership_householdId_fkey" FOREIGN KEY ("householdId") REFERENCES "Household"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HouseholdMembership" ADD CONSTRAINT "HouseholdMembership_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Recipe" ADD CONSTRAINT "Recipe_householdId_fkey" FOREIGN KEY ("householdId") REFERENCES "Household"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WeekPlan" ADD CONSTRAINT "WeekPlan_householdId_fkey" FOREIGN KEY ("householdId") REFERENCES "Household"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PantryItem" ADD CONSTRAINT "PantryItem_householdId_fkey" FOREIGN KEY ("householdId") REFERENCES "Household"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShoppingTrip" ADD CONSTRAINT "ShoppingTrip_householdId_fkey" FOREIGN KEY ("householdId") REFERENCES "Household"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NewsletterSend" ADD CONSTRAINT "NewsletterSend_householdId_fkey" FOREIGN KEY ("householdId") REFERENCES "Household"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Settings" ADD CONSTRAINT "Settings_householdId_fkey" FOREIGN KEY ("householdId") REFERENCES "Household"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Backfill
-- A fixed identifier makes the migration deterministic on both existing and
-- newly-created databases. It is an opaque database key, not a public slug.
INSERT INTO "Household" ("id", "name", "createdAt", "updatedAt")
VALUES ('initial-household', 'Primary household', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);

UPDATE "Recipe" SET "householdId" = 'initial-household' WHERE "householdId" IS NULL;
UPDATE "WeekPlan" SET "householdId" = 'initial-household' WHERE "householdId" IS NULL;
UPDATE "PantryItem" SET "householdId" = 'initial-household' WHERE "householdId" IS NULL;
UPDATE "ShoppingTrip" SET "householdId" = 'initial-household' WHERE "householdId" IS NULL;
UPDATE "NewsletterSend" SET "householdId" = 'initial-household' WHERE "householdId" IS NULL;

-- Preserve the old equal-member behavior: every existing account administers
-- the household. Only the oldest account receives installation-wide powers.
INSERT INTO "HouseholdMembership" (
    "householdId", "userId", "role", "createdAt", "updatedAt"
)
SELECT
    'initial-household', "id", 'ADMIN'::"HouseholdRole", CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM "User";

UPDATE "User"
SET "platformRole" = 'ADMIN'
WHERE "id" = (
    SELECT "id" FROM "User" ORDER BY "createdAt" ASC, "id" ASC LIMIT 1
);

-- Keep the current id=1 settings interface working and ensure a fresh install
-- has the initial household's settings ready before first-run setup.
INSERT INTO "Settings" ("id", "householdId", "householdSize", "updatedAt")
VALUES (1, 'initial-household', 2, CURRENT_TIMESTAMP)
ON CONFLICT ("id") DO UPDATE SET "householdId" = EXCLUDED."householdId";

SELECT setval(
    '"Settings_id_seq"',
    GREATEST((SELECT COALESCE(MAX("id"), 1) FROM "Settings"), 1),
    true
);

-- Verify the one-time backfill before Prisma records the migration as applied.
-- Columns stay nullable for rolling-deploy compatibility, so these checks are
-- the guard that distinguishes deliberately nullable future writes from a
-- failed migration of existing rows.
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM "Recipe" WHERE "householdId" IS NULL
        UNION ALL SELECT 1 FROM "WeekPlan" WHERE "householdId" IS NULL
        UNION ALL SELECT 1 FROM "PantryItem" WHERE "householdId" IS NULL
        UNION ALL SELECT 1 FROM "ShoppingTrip" WHERE "householdId" IS NULL
        UNION ALL SELECT 1 FROM "NewsletterSend" WHERE "householdId" IS NULL
    ) THEN
        RAISE EXCEPTION 'household ownership backfill left unowned rows';
    END IF;

    IF EXISTS (
        SELECT 1
        FROM "User" u
        LEFT JOIN "HouseholdMembership" m
          ON m."userId" = u."id"
         AND m."householdId" = 'initial-household'
        WHERE m."userId" IS NULL
    ) THEN
        RAISE EXCEPTION 'household membership backfill left users unassigned';
    END IF;

    IF EXISTS (SELECT 1 FROM "User")
       AND NOT EXISTS (SELECT 1 FROM "User" WHERE "platformRole" = 'ADMIN') THEN
        RAISE EXCEPTION 'platform administrator backfill did not promote a user';
    END IF;
END $$;
