import 'reflect-metadata';
import { config as loadEnv } from 'dotenv';
import { Pool } from 'pg';
import { ensureDatabaseExists, resetSchema, runMigrations } from './migrator';

loadEnv();

const logger = { log: (message: string) => console.log(`[migrate] ${message}`) };

async function main(): Promise<void> {
  const url =
    process.env.NODE_ENV === 'test'
      ? (process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL)
      : process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set');

  await ensureDatabaseExists(url, logger);
  const pool = new Pool({ connectionString: url, max: 2 });
  try {
    if (process.argv.includes('--reset')) {
      await resetSchema(pool, logger);
    }
    const count = await runMigrations(pool, logger);
    logger.log(count === 0 ? 'schema already up to date' : `applied ${count} migration(s)`);
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error('[migrate] failed:', error);
  process.exit(1);
});
