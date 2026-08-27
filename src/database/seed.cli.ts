import 'reflect-metadata';
import { config as loadEnv } from 'dotenv';
import { Pool } from 'pg';
import { seedDatabase } from './seed';

loadEnv();

const logger = { log: (message: string) => console.log(`[seed] ${message}`) };

async function main(): Promise<void> {
  const url =
    process.env.NODE_ENV === 'test'
      ? (process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL)
      : process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set');

  const pool = new Pool({ connectionString: url, max: 2 });
  try {
    await seedDatabase(pool, logger);
    logger.log('done');
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error('[seed] failed:', error);
  process.exit(1);
});
