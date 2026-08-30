-- Sides and desserts get shelves of their own, next to drinks (§2c).
--
-- Same argument as drinks, twice over. A pavlova and a grøn salat are recipes
-- by every test that matters — pasted and parsed the same way, with
-- ingredients, a method whose timers work (§2), and a photo — but neither is a
-- dinner, and filed as one they turned up in the night picker and in the
-- dashboard's "what shall we have?" (§2e) as serious answers for a Tuesday. Two
-- more values on the existing enum rather than new columns: "what is this
-- recipe" is one question with one answer, and a recipe that is both a dinner
-- and a dessert is not something the library needs to represent.
--
-- The two are not the same downstream, which is the point of separating them
-- rather than adding one "not dinner" value. A side goes on a night with the
-- main it accompanies, so it reaches the plan and the shopping list (§5) like
-- any dinner; a dessert does not. That difference lives in isPlannable /
-- isSuggestable (src/lib/recipeKind.ts), not here — the column only records
-- what the recipe is.
--
-- Nothing to backfill, and nothing guessed. The salads and the cakes already in
-- the library are sitting among the dinners under names somebody typed; only
-- that somebody knows which are which, and they re-file them on the edit page.
-- Reading "salat" or "kage" out of the names here would be exactly the invented
-- claim §2d refuses to make about categories.

-- AlterEnum
ALTER TYPE "RecipeKind" ADD VALUE 'SIDE';
ALTER TYPE "RecipeKind" ADD VALUE 'DESSERT';
