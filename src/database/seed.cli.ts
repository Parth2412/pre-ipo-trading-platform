import 'reflect-metadata';
import { config as loadEnv } from 'dotenv';
import { hash } from 'bcryptjs';
import { Pool, PoolClient } from 'pg';
import { PRICE_SCALE, parsePrice } from '../common/money';
import { SEED_ASSETS } from './seed-data';

loadEnv();

const log = (message: string) => console.log(`[seed] ${message}`);

interface SeedUser {
  email: string;
  password: string;
  displayName: string;
  role: 'USER' | 'ADMIN';
  depositUsd: string;
}

const SEED_USERS: SeedUser[] = [
  { email: 'alice@example.com', password: 'Password123!', displayName: 'Alice', role: 'USER', depositUsd: '250000' },
  { email: 'bob@example.com', password: 'Password123!', displayName: 'Bob', role: 'USER', depositUsd: '250000' },
  { email: 'admin@example.com', password: 'Password123!', displayName: 'Platform Admin', role: 'ADMIN', depositUsd: '1000000' },
];

async function seedAssets(client: PoolClient): Promise<void> {
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

    // Seed the price history with the opening print so the market has a mark
    // even before the simulation produces its first tick.
    const { rowCount } = await client.query('SELECT 1 FROM price_ticks WHERE symbol = $1 LIMIT 1', [
      asset.symbol,
    ]);
    if (!rowCount) {
      await client.query('INSERT INTO price_ticks (symbol, price) VALUES ($1, $2)', [
        asset.symbol,
        asset.initialPrice.toString(),
      ]);
    }
    log(`asset ${asset.symbol} @ $${Number(asset.initialPrice) / Number(PRICE_SCALE)}`);
  }
}

async function seedUsers(client: PoolClient): Promise<void> {
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
      log(`user ${user.email} already present`);
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
    log(`user ${user.email} (${user.role}) funded with $${user.depositUsd}`);
  }
}

async function main(): Promise<void> {
  const url =
    process.env.NODE_ENV === 'test'
      ? (process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL)
      : process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set');

  const pool = new Pool({ connectionString: url, max: 2 });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await seedAssets(client);
    await seedUsers(client);
    await client.query('COMMIT');
    log('done');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((error) => {
  console.error('[seed] failed:', error);
  process.exit(1);
});
