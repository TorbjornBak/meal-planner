-- Multiple dinners per night (§3). A DinnerSlot is now one assigned dinner,
-- not a fixed per-day cell: the one-per-day unique constraint is dropped,
-- `recipeId` becomes required (empty nights simply have no slots), and a
-- `position` column orders the dinners within a night.

-- Pre-created empty slots no longer carry meaning; drop them.
DELETE FROM "DinnerSlot" WHERE "recipeId" IS NULL;

-- DropIndex
DROP INDEX "DinnerSlot_weekPlanId_dayOfWeek_key";

-- DropForeignKey (re-added below with ON DELETE CASCADE)
ALTER TABLE "DinnerSlot" DROP CONSTRAINT "DinnerSlot_recipeId_fkey";

-- AlterTable
ALTER TABLE "DinnerSlot"
  ALTER COLUMN "recipeId" SET NOT NULL,
  ADD COLUMN "position" INTEGER NOT NULL DEFAULT 0;

-- AddForeignKey
ALTER TABLE "DinnerSlot" ADD CONSTRAINT "DinnerSlot_recipeId_fkey" FOREIGN KEY ("recipeId") REFERENCES "Recipe"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- CreateIndex
CREATE INDEX "DinnerSlot_weekPlanId_dayOfWeek_idx" ON "DinnerSlot"("weekPlanId", "dayOfWeek");
