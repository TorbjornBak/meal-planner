-- CreateTable
CREATE TABLE "Recipe" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "source" TEXT,
    "statedServings" INTEGER NOT NULL,
    "isFavorite" BOOLEAN NOT NULL DEFAULT false,
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Recipe_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IngredientLine" (
    "id" TEXT NOT NULL,
    "recipeId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "quantity" DOUBLE PRECISION,
    "unit" TEXT,
    "position" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "IngredientLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WeekPlan" (
    "id" TEXT NOT NULL,
    "weekStart" DATE NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WeekPlan_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DinnerSlot" (
    "id" TEXT NOT NULL,
    "weekPlanId" TEXT NOT NULL,
    "dayOfWeek" INTEGER NOT NULL,
    "recipeId" TEXT,
    "servingsOverride" INTEGER,

    CONSTRAINT "DinnerSlot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ShoppingList" (
    "id" TEXT NOT NULL,
    "weekPlanId" TEXT NOT NULL,
    "generatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ShoppingList_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ShoppingListItem" (
    "id" TEXT NOT NULL,
    "shoppingListId" TEXT NOT NULL,
    "ingredientKey" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "quantity" DOUBLE PRECISION,
    "unit" TEXT,
    "altQuantity" DOUBLE PRECISION,
    "altUnit" TEXT,
    "checked" BOOLEAN NOT NULL DEFAULT false,
    "isPantry" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "ShoppingListItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PantryItem" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "nameKey" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PantryItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ShoppingTrip" (
    "id" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "store" TEXT NOT NULL,
    "total" MONEY NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ShoppingTrip_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Receipt" (
    "id" TEXT NOT NULL,
    "tripId" TEXT NOT NULL,
    "photo" BYTEA NOT NULL,
    "mimeType" TEXT NOT NULL,
    "uploadedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Receipt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Settings" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "householdSize" INTEGER NOT NULL DEFAULT 2,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Settings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Recipe_isFavorite_idx" ON "Recipe"("isFavorite");

-- CreateIndex
CREATE INDEX "IngredientLine_recipeId_idx" ON "IngredientLine"("recipeId");

-- CreateIndex
CREATE UNIQUE INDEX "WeekPlan_weekStart_key" ON "WeekPlan"("weekStart");

-- CreateIndex
CREATE INDEX "DinnerSlot_recipeId_idx" ON "DinnerSlot"("recipeId");

-- CreateIndex
CREATE UNIQUE INDEX "DinnerSlot_weekPlanId_dayOfWeek_key" ON "DinnerSlot"("weekPlanId", "dayOfWeek");

-- CreateIndex
CREATE UNIQUE INDEX "ShoppingList_weekPlanId_key" ON "ShoppingList"("weekPlanId");

-- CreateIndex
CREATE INDEX "ShoppingListItem_shoppingListId_idx" ON "ShoppingListItem"("shoppingListId");

-- CreateIndex
CREATE UNIQUE INDEX "ShoppingListItem_shoppingListId_ingredientKey_key" ON "ShoppingListItem"("shoppingListId", "ingredientKey");

-- CreateIndex
CREATE UNIQUE INDEX "PantryItem_nameKey_key" ON "PantryItem"("nameKey");

-- CreateIndex
CREATE INDEX "ShoppingTrip_date_idx" ON "ShoppingTrip"("date");

-- CreateIndex
CREATE UNIQUE INDEX "Receipt_tripId_key" ON "Receipt"("tripId");

-- AddForeignKey
ALTER TABLE "IngredientLine" ADD CONSTRAINT "IngredientLine_recipeId_fkey" FOREIGN KEY ("recipeId") REFERENCES "Recipe"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DinnerSlot" ADD CONSTRAINT "DinnerSlot_weekPlanId_fkey" FOREIGN KEY ("weekPlanId") REFERENCES "WeekPlan"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DinnerSlot" ADD CONSTRAINT "DinnerSlot_recipeId_fkey" FOREIGN KEY ("recipeId") REFERENCES "Recipe"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShoppingList" ADD CONSTRAINT "ShoppingList_weekPlanId_fkey" FOREIGN KEY ("weekPlanId") REFERENCES "WeekPlan"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShoppingListItem" ADD CONSTRAINT "ShoppingListItem_shoppingListId_fkey" FOREIGN KEY ("shoppingListId") REFERENCES "ShoppingList"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Receipt" ADD CONSTRAINT "Receipt_tripId_fkey" FOREIGN KEY ("tripId") REFERENCES "ShoppingTrip"("id") ON DELETE CASCADE ON UPDATE CASCADE;
