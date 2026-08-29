-- How long a recipe takes (§1, §2).
--
-- "What's quick on a Tuesday" is the question that picks a weeknight dinner,
-- and the library couldn't answer it — a Recipe had no time on it at all.
-- `totalTimeMinutes` is filled from the source page's schema.org totalTime
-- (or prepTime + cookTime) where the page declares one, and otherwise
-- estimated by summing the step timers we already parse out of the method.
--
-- `totalTimeIsEstimate` keeps the two apart, because they are not equally
-- trustworthy: summed step times overstate a dish (steps overlap, resting
-- counts as cooking), so those are shown as "about 40 min" rather than stated
-- flat. Existing rows have no time at all, so both defaults are the correct
-- backfill: null, and not-an-estimate for whenever one is typed in by hand.

-- AlterTable
ALTER TABLE "Recipe" ADD COLUMN     "totalTimeMinutes" INTEGER,
ADD COLUMN     "totalTimeIsEstimate" BOOLEAN NOT NULL DEFAULT false;
