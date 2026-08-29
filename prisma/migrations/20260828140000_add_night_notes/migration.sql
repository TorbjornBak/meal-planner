-- A night that was decided rather than merely empty (§3, §9b).
--
-- §3 always allowed an empty night — leftovers, or eating out — but nothing
-- recorded that the household had *decided* it. So the weekly digest counted
-- every dinnerless night as a gap and mailed "Fill in the 4 empty nights" to a
-- household whose Wednesday is leftovers by standing arrangement. A nudge that
-- is wrong every week is the nothing-to-say mail §9b exists to avoid.
--
-- A table of its own, not a nullable DinnerSlot.recipeId: a null-recipe slot
-- would reach aggregateShoppingList (§5), the digest and the plan page, all of
-- which assume a slot has a recipe. Nothing here has ingredients, so the
-- shopping list never has to hear about it.
--
-- Nothing to backfill: every existing dinnerless night is genuinely undecided
-- until somebody says otherwise, which is what no row means.

-- CreateEnum
CREATE TYPE "NightNoteKind" AS ENUM ('LEFTOVERS', 'OUT', 'OTHER');

-- CreateTable
CREATE TABLE "NightNote" (
    "id" TEXT NOT NULL,
    "weekPlanId" TEXT NOT NULL,
    "dayOfWeek" INTEGER NOT NULL,
    "kind" "NightNoteKind" NOT NULL,
    "text" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "NightNote_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
-- One decision per night: deciding twice is changing your mind, so the API
-- upserts on this pair rather than stacking rows the way dinners do.
CREATE UNIQUE INDEX "NightNote_weekPlanId_dayOfWeek_key" ON "NightNote"("weekPlanId", "dayOfWeek");

-- AddForeignKey
ALTER TABLE "NightNote" ADD CONSTRAINT "NightNote_weekPlanId_fkey" FOREIGN KEY ("weekPlanId") REFERENCES "WeekPlan"("id") ON DELETE CASCADE ON UPDATE CASCADE;
