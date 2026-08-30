-- What a recipe is made of, at the level a household actually decides on (§2d).
--
-- "What shall we have?" is answered in two steps, and the library could only
-- help with the second. The first step is a category — we had fish on Monday,
-- so tonight isn't fish; there's a vegetarian coming Thursday — and the app
-- held nothing that could answer it. You could search for "torsk" if you
-- already knew you wanted cod, which is precisely the question you're stuck on.
--
-- An enum column rather than a reserved value in `tags`, for the same reason
-- `kind` is one (§2c): tags are free text a human types, so "veggie",
-- "Vegetarian" and "vegetar" would all mean this and none of them could be
-- trusted. That matters more here than it did for drinks. The dashboard's
-- suggestions (§2e) offer a recipe *as* vegetarian, and a filter that answers
-- that question from free text will eventually put a bolognese in front of
-- someone who asked for none. Better to be certain, or to say nothing.
--
-- Nullable, and nothing is backfilled. Every recipe already in the library
-- predates the question, and there is no honest way to answer it for them:
-- guessing from the ingredient lines would read "kylling" out of
-- "kyllingebouillon" and file a soup as meat, or miss the fish sauce in a
-- curry and call it vegan. A dietary claim we invented is worse than an absent
-- one, so an uncategorised recipe stays uncategorised and says so, until
-- somebody who knows sets it on the edit page.

-- CreateEnum
CREATE TYPE "RecipeCategory" AS ENUM ('MEAT', 'FISH', 'VEGETARIAN', 'VEGAN');

-- AlterTable
ALTER TABLE "Recipe" ADD COLUMN "category" "RecipeCategory";

-- CreateIndex
-- The library and the suggestion picker both read one category at a time.
CREATE INDEX "Recipe_category_idx" ON "Recipe"("category");
