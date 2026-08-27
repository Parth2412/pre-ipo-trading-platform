import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { NodePgDatabase, drizzle } from 'drizzle-orm/node-postgres';
import { sql } from 'drizzle-orm';
import { Pool } from 'pg';
import { APP_CONFIG, AppConfig } from '../config/configuration';
import { hashString } from '../common/random';
import { databaseSchema } from './schema';
import { ensureDatabaseExists, runMigrations } from './migrator';

export type Database = NodePgDatabase<typeof databaseSchema>;
/** A Drizzle handle bound to an open transaction. */
export type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0];
/** Anything you can run a query on — pool-backed or transaction-bound. */
export type Executor = Database | Transaction;

/**
 * Advisory lock namespaces. Postgres advisory locks take two 32-bit keys; the
 * first identifies the resource class so a symbol hash can never collide with a
 * user-id hash.
 */
export enum LockNamespace {
  Symbol = 1,
  User = 2,
}

/** Map an arbitrary string onto the signed 32-bit range Postgres expects. */
export function lockKey(value: string): number {
  return hashString(value) | 0;
}

@Injectable()
export class DatabaseService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(DatabaseService.name);
  private readonly pool: Pool;
  readonly db: Database;

  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {
    this.pool = new Pool({
      connectionString: config.database.url,
      max: config.database.poolMax,
      application_name: 'pre-ipo-trading-platform',
    });
    this.pool.on('error', (error) => this.logger.error('idle client error', error.stack));
    this.db = drizzle(this.pool, { schema: databaseSchema });
  }

  async onModuleInit(): Promise<void> {
    await ensureDatabaseExists(this.config.database.url, {
      log: (message) => this.logger.log(message),
    });
    const applied = await runMigrations(this.pool, { log: (message) => this.logger.log(message) });
    if (applied > 0) this.logger.log(`applied ${applied} migration(s)`);
  }

  async onModuleDestroy(): Promise<void> {
    await this.pool.end();
  }

  /**
   * Run `handler` inside a single transaction.
   *
   * READ COMMITTED plus explicit row locks is the right isolation level here:
   * every write path takes `SELECT ... FOR UPDATE` on the balance rows it
   * touches, so the anomalies SERIALIZABLE would prevent cannot occur, and we
   * avoid the retry loop that serialization failures would force on the hot
   * order path.
   */
  transaction<T>(handler: (tx: Transaction) => Promise<T>): Promise<T> {
    return this.db.transaction(handler);
  }

  /**
   * Take a transaction-scoped advisory lock. Released automatically on COMMIT or
   * ROLLBACK, so there is no leak path if the handler throws.
   *
   * Callers must acquire locks in a globally consistent order — symbol first,
   * then user ids sorted ascending — which is what makes the engine
   * deadlock-free under concurrent crossing orders.
   */
  static async acquireLock(
    tx: Transaction,
    namespace: LockNamespace,
    value: string,
  ): Promise<void> {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(${namespace}::int, ${lockKey(value)}::int)`);
  }

  static async lockSymbol(tx: Transaction, symbol: string): Promise<void> {
    await DatabaseService.acquireLock(tx, LockNamespace.Symbol, symbol);
  }

  /** Lock a set of users in a deterministic (sorted) order to prevent deadlocks. */
  static async lockUsers(tx: Transaction, userIds: readonly string[]): Promise<void> {
    const unique = [...new Set(userIds)].sort();
    for (const userId of unique) {
      await DatabaseService.acquireLock(tx, LockNamespace.User, userId);
    }
  }

  /** Escape hatch for tests and health checks. */
  async ping(): Promise<boolean> {
    const result = await this.pool.query('SELECT 1 AS ok');
    return result.rows[0]?.ok === 1;
  }
}
