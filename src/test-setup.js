import { applyD1Migrations, env } from 'cloudflare:test';
import { beforeAll } from 'vitest';
import { seedTestDatabase } from '../scripts/seed-db.mjs';

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  await seedTestDatabase(env.DB);
});
