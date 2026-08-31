import { PrismaClient } from "@prisma/client";

// Minimal seed: the initial household's settings and a couple of pantry staples.
const prisma = new PrismaClient();
const INITIAL_HOUSEHOLD_ID = "initial-household";

async function main() {
  await prisma.household.upsert({
    where: { id: INITIAL_HOUSEHOLD_ID },
    update: {},
    create: { id: INITIAL_HOUSEHOLD_ID, name: "Primary household" },
  });

  await prisma.settings.upsert({
    where: { id: 1 },
    update: { householdId: INITIAL_HOUSEHOLD_ID },
    create: { id: 1, householdId: INITIAL_HOUSEHOLD_ID, householdSize: 2 },
  });

  for (const name of ["Salt", "Olive oil", "Black pepper"]) {
    await prisma.pantryItem.upsert({
      where: { nameKey: name.toLowerCase() },
      update: {},
      create: {
        householdId: INITIAL_HOUSEHOLD_ID,
        name,
        nameKey: name.toLowerCase(),
      },
    });
  }
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (e) => {
    console.error(e);
    await prisma.$disconnect();
    process.exit(1);
  });
