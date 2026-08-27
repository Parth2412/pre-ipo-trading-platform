import { hash } from 'bcryptjs';
import { Pool, PoolClient } from 'pg';
import { parsePrice } from '../common/money';
import { SEED_ASSETS } from './seed-data';

export interface SeedLogger {
  log(message: string): void;
}

const noopLogger: SeedLogger = { log: () => undefined };

interface SeedUser {
  readonly email: string;
  readonly password: string;
  readonly displayName: string;
  readonly role: 'USER' | 'ADMIN';
  readonly depositUsd: string;
}

/** Demo accounts. Every one uses the same password so the console is easy to try. */
export const SEED_USERS: readonly SeedUser[] = [
  {
    email: 'alice@example.com',
    password: 'Password123!',
    displayName: 'Alice',
    role: 'USER',
    depositUsd: '250000',
  },
  {
    email: 'bob@example.com',
    password: 'Password123!',
    displayName: 'Bob',
    role: 'USER',
    depositUsd: '250000',
  },
  {
    email: 'admin@example.com',
    password: 'Password123!',
    displayName: 'Platform Admin',
    role: 'ADMIN',
    depositUsd: '1000000',
  },
];

async function seedAssets(client: PoolClient, logger: SeedLogger): Promise<void> {
  for (const asset of SEED_ASSETS) {
    await client.query(
      `INSERT INTO assets (symbol, name, description, sector, initial_price, annual_drift_bps,
                           annual_vol_bps, tick_size, lot_size, min_order_notional)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       ON CONFLICT (symbol) DO UPDATE SET
         name = EXCLUDED.name,
         description = EXCLUDED.description,
         sector = EXCLUDED.sector,
         annual_drift_bps = EXCLUDED.annual_drift_bps,
         annual_vol_bps = EXCLUDED.annual_vol_bps,
         tick_size = EXCLUDED.tick_size,
         lot_size = EXCLUDED.lot_size,
         min_order_notional = EXCLUDED.min_order_notional`,
      [
        asset.symbol,
        asset.name,
        asset.description,
        asset.sector,
        asset.initialPrice.toString(),
        asset.annualDriftBps,
        asset.annualVolBps,
        asset.tickSize.toString(),
        asset.lotSize.toString(),
        asset.minOrderNotional.toString(),
      ],
    );

    // Seed the tape with the opening print so the market has a mark before the
    // simulation produces its first tick.
    const { rowCount } = await client.query('SELECT 1 FROM price_ticks WHERE symbol = $1 LIMIT 1', [
      asset.symbol,
    ]);
    if (!rowCount) {
      await client.query('INSERT INTO price_ticks (symbol, price) VALUES ($1, $2)', [
        asset.symbol,
        asset.initialPrice.toString(),
      ]);
    }
    logger.log(`asset ${asset.symbol} — ${asset.name}`);
  }
}

async function seedUsers(client: PoolClient, logger: SeedLogger): Promise<void> {
  for (const user of SEED_USERS) {
    const passwordHash = await hash(user.password, 10);
    const inserted = await client.query<{ id: string }>(
      `INSERT INTO users (email, password_hash, display_name, role)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (lower(email)) DO NOTHING
       RETURNING id`,
      [user.email, passwordHash, user.displayName, user.role],
    );
    if (!inserted.rowCount) {
      logger.log(`user ${user.email} already present`);
      continue;
    }

    const userId = inserted.rows[0].id;
    const deposit = parsePrice(user.depositUsd).toString();
    await client.query(
      `INSERT INTO balances (user_id, account, asset_symbol, amount, version)
       VALUES ($1, 'CASH', NULL, $2, 1)`,
      [userId, deposit],
    );
    await client.query(
      `INSERT INTO ledger_entries (user_id, account, asset_symbol, delta, balance_after,
                                   entry_type, ref_type, ref_id, memo)
       VALUES ($1::uuid, 'CASH', NULL, $2::bigint, $2::bigint, 'DEPOSIT', 'SIGNUP', $1::text, 'Seed deposit')`,
      [userId, deposit],
    );
    logger.log(`user ${user.email} (${user.role}) funded with $${user.depositUsd}`);
  }
}

/** Idempotent: safe to run against an already-seeded database. */
export async function seedDatabase(pool: Pool, logger: SeedLogger = noopLogger): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await seedAssets(client, logger);
    await seedUsers(client, logger);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
