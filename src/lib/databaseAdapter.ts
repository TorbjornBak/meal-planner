import { PrismaPg } from "@prisma/adapter-pg";

/** Keep Prisma's schema URL option when switching from the Rust engine to pg. */
export function databaseAdapter(connectionString = process.env.DATABASE_URL) {
  const schema = connectionString ? new URL(connectionString).searchParams.get("schema") ?? undefined : undefined;
  return new PrismaPg(
    { connectionString, connectionTimeoutMillis: 5_000 },
    { schema },
  );
}
