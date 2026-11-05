import { databaseAdapter } from "./databaseAdapter.ts";
import { PrismaClient } from "@/generated/prisma/client";

// Reuse a single client across hot reloads in dev to avoid exhausting
// Postgres connections.
const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    adapter: databaseAdapter(),
    log: process.env.NODE_ENV === "development" ? ["warn", "error"] : ["error"],
  });

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = prisma;
