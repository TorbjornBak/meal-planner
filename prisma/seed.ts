import { PrismaClient } from "@prisma/client";

// Minimal seed: the singleton settings row and a couple of pantry staples.
const prisma = new PrismaClient();

async function main() {
  await prisma.settings.upsert({
    where: { id: 1 },
    update: {},
    create: { id: 1, householdSize: 2 },
  });

  for (const name of ["Salt", "Olive oil", "Black pepper"]) {
    await prisma.pantryItem.upsert({
      where: { nameKey: name.toLowerCase() },
      update: {},
      create: { name, nameKey: name.toLowerCase() },
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
