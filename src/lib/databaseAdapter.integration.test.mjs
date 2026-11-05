import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { PrismaClient } from '../generated/prisma/client.ts';
import { databaseAdapter } from './databaseAdapter.ts';

test('PostgreSQL adapter respects the schema URL option for model queries and transactions', {
  skip: !process.env.DATABASE_URL && 'DATABASE_URL is not set',
}, async () => {
  const schema = `adapter_test_${randomUUID().replaceAll('-', '')}`;
  const url = new URL(process.env.DATABASE_URL);
  const baseSchema = url.searchParams.get('schema') || 'public';
  const base = new PrismaClient({ adapter: databaseAdapter(url.toString()) });
  url.searchParams.set('schema', schema);
  const isolated = new PrismaClient({ adapter: databaseAdapter(url.toString()) });
  const quote = value => '"' + value.replaceAll('"', '""') + '"';
  const id = randomUUID();
  try {
    await base.$executeRawUnsafe(`CREATE SCHEMA ${quote(schema)}`);
    await base.$executeRawUnsafe(`CREATE TABLE ${quote(schema)}."Household" (LIKE ${quote(baseSchema)}."Household" INCLUDING ALL)`);
    await isolated.$transaction(async tx => {
      await tx.household.create({ data: { id, name: 'Prisma 7 schema test' } });
    });
    assert.equal((await isolated.household.findUnique({ where: { id } })).name, 'Prisma 7 schema test');
    assert.equal(await base.household.findUnique({ where: { id } }), null);
  } finally {
    await isolated.$disconnect();
    await base.$executeRawUnsafe(`DROP SCHEMA IF EXISTS ${quote(schema)} CASCADE`);
    await base.$disconnect();
  }
});
