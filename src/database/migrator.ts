import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { Client, Pool } from 'pg';

const MIGRATIONS_DIR = join(__dirname, 'migrations');

export interface MigrationLogger {
  log(message: string): void;
}

const noopLogger: MigrationLogger = { log: () => undefined };

interface MigrationFile {
  readonly name: string;
  readonly sql: string;
  readonly checksum: string;
}

function loadMigrations(): MigrationFile[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((file) => file.endsWith('.sql'))
    .sort()
    .map((name) => {
      const sql = readFileSync(join(MIGRATIONS_DIR, name), 'utf8');
      return { name, sql, checksum: createHash('sha256').update(sql).digest('hex') };
    });
}

/**
 * Minimal forward-only migration runner.
 *
 * Deliberately hand-rolled rather than delegated to a CLI: the schema relies on
 * CHECK constraints, partial indexes, expression indexes and a view, none of
 * which round-trip cleanly through ORM-generated DDL. Each file runs inside its
 * own transaction and is recorded with a checksum, so an edited migration that
 * has already been applied fails loudly instead of drifting silently.
 */
export async function runMigrations(pool: Pool, logger: MigrationLogger = noopLogger): Promise<number> {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        name        TEXT PRIMARY KEY,
        checksum    TEXT NOT NULL,
        applied_at  TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);

    const { rows } = await client.query<{ name: string; checksum: string }>(
      'SELECT name, checksum FROM schema_migrations',
    );
    const applied = new Map(rows.map((row) => [row.name, row.checksum]));

    let executed = 0;
    for (const migration of loadMigrations()) {
      const previous = applied.get(migration.name);
      if (previous) {
        if (previous !== migration.checksum) {
          throw new Error(
            `Migration ${migration.name} has already been applied but its contents changed. ` +
              'Add a new migration instead of editing an applied one.',
          );
        }
        continue;
      }

      logger.log(`applying ${migration.name}`);
      await client.query('BEGIN');
      try {
        await client.query(migration.sql);
        await client.query('INSERT INTO schema_migrations (name, checksum) VALUES ($1, $2)', [
          migration.name,
          migration.checksum,
        ]);
        await client.query('COMMIT');
        executed += 1;
      } catch (error) {
        await client.query('ROLLBACK');
        throw new Error(`Migration ${migration.name} failed: ${(error as Error).message}`, {
          cause: error,
        });
      }
    }
    return executed;
  } finally {
    client.release();
  }
}

/** Drop and recreate the public schema. Destructive; development and tests only. */
export async function resetSchema(pool: Pool, logger: MigrationLogger = noopLogger): Promise<void> {
  logger.log('dropping schema public');
  await pool.query('DROP SCHEMA IF EXISTS public CASCADE');
  await pool.query('CREATE SCHEMA public');
}

/**
 * Create the target database if it does not exist yet, by connecting to the
 * maintenance database on the same server. Keeps `pnpm test:e2e` a one-liner.
 */
export async function ensureDatabaseExists(connectionUrl: string, logger: MigrationLogger = noopLogger): Promise<void> {
  const url = new URL(connectionUrl);
  const databaseName = decodeURIComponent(url.pathname.replace(/^\//, ''));
  if (!databaseName) throw new Error(`Connection string has no database name: ${connectionUrl}`);

  const adminUrl = new URL(connectionUrl);
  adminUrl.pathname = '/postgres';

  const client = new Client({ connectionString: adminUrl.toString() });
  await client.connect();
  try {
    const { rowCount } = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [
      databaseName,
    ]);
    if (!rowCount) {
      logger.log(`creating database ${databaseName}`);
      // Identifiers cannot be parameterised; the name comes from our own config.
      await client.query(`CREATE DATABASE "${databaseName.replace(/"/g, '""')}"`);
    }
  } finally {
    await client.end();
  }
}
