-- Recipes are dinners or drinks (§2c).
--
-- The library has only ever held one kind of thing, because the plan holds one
-- kind of thing (§3). But a household's coffee ratios, its cordials and its
-- gløgg are recipes by every test that matters — pasted and parsed the same
-- way, with ingredients, a method whose timers work (§2), and a photo — and
-- they were being kept somewhere else, or not at all, because dropping them
-- into the library meant scrolling past six coffees to find the ragù.
--
-- An enum column rather than a reserved value in `tags`: tags are free text a
-- human types, so "drink", "Drink" and "drinks" would all mean this and none of
-- them could be trusted by the plan picker, which has to be certain a recipe is
-- plannable before it offers it as tonight's dinner.
--
-- Nothing to backfill. Every recipe that predates this was typed in to be
-- eaten, which is exactly what the default says.

-- CreateEnum
CREATE TYPE "RecipeKind" AS ENUM ('DINNER', 'DRINK');

-- AlterTable
ALTER TABLE "Recipe" ADD COLUMN "kind" "RecipeKind" NOT NULL DEFAULT 'DINNER';

-- CreateIndex
-- The library reads one kind at a time, and the plan picker only ever wants
-- DINNER.
CREATE INDEX "Recipe_kind_idx" ON "Recipe"("kind");
