ALTER TABLE "Recipe" ADD COLUMN "bookTitle" TEXT, ADD COLUMN "bookAuthor" TEXT, ADD COLUMN "bookPage" TEXT;
CREATE TABLE "RecipeSourcePage" (
 "id" TEXT NOT NULL PRIMARY KEY,
 "recipeId" TEXT NOT NULL,
 "position" INTEGER NOT NULL,
 "photo" BYTEA NOT NULL,
 "mime" TEXT NOT NULL,
 "transcript" TEXT NOT NULL,
 CONSTRAINT "RecipeSourcePage_recipeId_fkey" FOREIGN KEY ("recipeId") REFERENCES "Recipe"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "RecipeSourcePage_recipeId_position_key" ON "RecipeSourcePage"("recipeId", "position");
