import { config as loadEnv } from 'dotenv';
import { Pool } from 'pg';
import { ensureDatabaseExists, resetSchema, runMigrations } from '../src/database/migrator';
import { seedDatabase } from '../src/database/seed';

/**
 * Prepares a dedicated test database once for the whole run: create if missing,
 * drop the schema, migrate, seed the market and the demo accounts.
 *
 * A separate database rather than transactional rollback per test, because the
 * engine relies on advisory locks and `FOR UPDATE` across several connections —
 * behaviour a single wrapping transaction would hide.
 */
export default async function globalSetup(): Promise<void> {
  loadEnv({ quiet: true });
  process.env.NODE_ENV = 'test';

  const url =
    process.env.TEST_DATABASE_URL ??
    process.env.DATABASE_URL?.replace(/\/([^/?]+)(\?|$)/, '/$1_test$2');
  if (!url) {
    throw new Error('Set TEST_DATABASE_URL (or DATABASE_URL) before running the e2e suite.');
  }
  process.env.TEST_DATABASE_URL = url;

  await ensureDatabaseExists(url);
  const pool = new Pool({ connectionString: url, max: 2 });
  try {
    await resetSchema(pool);
    await runMigrations(pool);
    await seedDatabase(pool);
  } finally {
    await pool.end();
  }
}
