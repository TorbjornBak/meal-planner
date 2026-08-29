-- Hand-added shopping-list lines (§5, §6).
--
-- The list was rebuilt from the week's plan on every generation, so anything
-- that isn't an ingredient in a planned dinner — kitchen roll, nappies, milk —
-- had nowhere to live, and the household kept a second list on someone's
-- phone. `isManual` marks the rows generation must carry across untouched
-- instead of deleting.
--
-- Existing rows are all plan-derived, so the default is the correct backfill.

-- AlterTable
ALTER TABLE "ShoppingListItem" ADD COLUMN     "isManual" BOOLEAN NOT NULL DEFAULT false;
