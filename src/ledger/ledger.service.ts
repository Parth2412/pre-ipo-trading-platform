import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { Executor, Transaction } from '../database/database.service';
import { InsufficientFundsException, InsufficientSharesException } from '../common/errors';
import { formatCash, formatQuantity } from '../common/money';
import {
  AccountBalance,
  CASH,
  LedgerAccount,
  LedgerPosting,
  PostedEntry,
} from './ledger.types';

interface BalanceRow {
  amount: string;
}

interface EntryRow {
  id: string;
  user_id: string;
  account: LedgerAccount;
  asset_symbol: string | null;
  delta: string;
  balance_after: string;
  created_at: Date;
}

/**
 * The double-entry ledger.
 *
 * Every change to cash or shares goes through `post()`. Two invariants are
 * enforced here and nowhere else:
 *
 *   1. No balance may go negative. Attempting it raises a domain error rather
 *      than a constraint violation, so the API can explain what was short.
 *   2. `ledger_entries.balance_after` is written under the same row lock that
 *      guards the balance update, which is what lets point-in-time queries read
 *      a running balance instead of folding the whole history.
 *
 * Postings inside a batch are applied in a deterministic (user, account, asset)
 * order so that concurrent transactions touching the same accounts always take
 * row locks in the same sequence.
 */
@Injectable()
export class LedgerService {
  /** Apply a batch of postings atomically. Caller supplies the transaction. */
  async post(tx: Transaction, postings: readonly LedgerPosting[]): Promise<PostedEntry[]> {
    const ordered = [...postings]
      .filter((posting) => posting.delta !== 0n)
      .sort(comparePostings);

    const results: PostedEntry[] = [];
    for (const posting of ordered) {
      results.push(await this.applyPosting(tx, posting));
    }
    return results;
  }

  private async applyPosting(tx: Transaction, posting: LedgerPosting): Promise<PostedEntry> {
    const { userId, account, assetSymbol, delta } = posting;

    // Ensure the account row exists, then lock it for the rest of the transaction.
    await tx.execute(sql`
      INSERT INTO balances (user_id, account, asset_symbol, amount)
      VALUES (${userId}::uuid, ${account}::text, ${assetSymbol}::text, 0)
      ON CONFLICT (user_id, account, COALESCE(asset_symbol, '')) DO NOTHING
    `);

    const locked = await tx.execute(sql`
      SELECT amount FROM balances
      WHERE user_id = ${userId}::uuid
        AND account = ${account}::text
        AND COALESCE(asset_symbol, '') = COALESCE(${assetSymbol}::text, '')
      FOR UPDATE
    `);
    const current = BigInt((locked.rows[0] as unknown as BalanceRow).amount);
    const next = current + delta;

    if (next < 0n) {
      throw shortfallError(account, assetSymbol, current, -delta);
    }

    await tx.execute(sql`
      UPDATE balances
         SET amount = ${next.toString()}::bigint,
             version = version + 1,
             updated_at = clock_timestamp()
       WHERE user_id = ${userId}::uuid
         AND account = ${account}::text
         AND COALESCE(asset_symbol, '') = COALESCE(${assetSymbol}::text, '')
    `);

    const inserted = await tx.execute(sql`
      INSERT INTO ledger_entries
        (user_id, account, asset_symbol, delta, balance_after, entry_type, ref_type, ref_id, memo)
      VALUES
        (${userId}::uuid, ${account}::text, ${assetSymbol}::text, ${delta.toString()}::bigint,
         ${next.toString()}::bigint, ${posting.entryType}::text, ${posting.refType ?? null}::text,
         ${posting.refId ?? null}::text, ${posting.memo ?? ''}::text)
      RETURNING id, user_id, account, asset_symbol, delta, balance_after, created_at
    `);

    const row = inserted.rows[0] as unknown as EntryRow;
    return {
      id: BigInt(row.id),
      userId: row.user_id,
      account: row.account,
      assetSymbol: row.asset_symbol,
      delta: BigInt(row.delta),
      balanceAfter: BigInt(row.balance_after),
      createdAt: row.created_at,
    };
  }

  /** Credit stablecoin to a user. Used by signup bonuses and admin top-ups. */
  async deposit(
    tx: Transaction,
    userId: string,
    amount: bigint,
    memo: string,
    refType: LedgerPosting['refType'] = 'ADMIN',
  ): Promise<PostedEntry> {
    const [entry] = await this.post(tx, [
      {
        userId,
        account: CASH,
        assetSymbol: null,
        delta: amount,
        entryType: 'DEPOSIT',
        refType,
        refId: userId,
        memo,
      },
    ]);
    return entry;
  }

  /** Current balance of a single account. Returns 0n when the row does not exist. */
  async getBalance(
    executor: Executor,
    userId: string,
    account: LedgerAccount,
    assetSymbol: string | null,
  ): Promise<bigint> {
    const result = await executor.execute(sql`
      SELECT amount FROM balances
      WHERE user_id = ${userId}::uuid
        AND account = ${account}::text
        AND COALESCE(asset_symbol, '') = COALESCE(${assetSymbol}::text, '')
    `);
    const row = result.rows[0] as unknown as BalanceRow | undefined;
    return row ? BigInt(row.amount) : 0n;
  }

  /** Every non-zero account the user holds right now. */
  async getBalances(executor: Executor, userId: string): Promise<AccountBalance[]> {
    const result = await executor.execute(sql`
      SELECT account, asset_symbol, amount
      FROM balances
      WHERE user_id = ${userId}::uuid
      ORDER BY account, COALESCE(asset_symbol, '')
    `);
    return (result.rows as unknown as Array<BalanceRow & { account: LedgerAccount; asset_symbol: string | null }>).map(
      (row) => ({
        account: row.account,
        assetSymbol: row.asset_symbol,
        amount: BigInt(row.amount),
      }),
    );
  }

  /**
   * Balance of one account as it stood at `at`.
   *
   * Reads the running balance carried on the newest entry at or before the
   * timestamp — an index seek on `ledger_entries_pit_idx`, not an aggregate.
   */
  async balanceAt(
    executor: Executor,
    userId: string,
    account: LedgerAccount,
    assetSymbol: string | null,
    at: Date,
  ): Promise<bigint> {
    const result = await executor.execute(sql`
      SELECT balance_after
      FROM ledger_entries
      WHERE user_id = ${userId}::uuid
        AND account = ${account}::text
        AND COALESCE(asset_symbol, '') = COALESCE(${assetSymbol}::text, '')
        AND created_at <= ${at.toISOString()}::timestamptz
      ORDER BY created_at DESC, id DESC
      LIMIT 1
    `);
    const row = result.rows[0] as unknown as { balance_after: string } | undefined;
    return row ? BigInt(row.balance_after) : 0n;
  }

  /**
   * Every account balance as it stood at `at`, derived with a window function
   * that picks the latest entry per account. One pass, no per-account query.
   */
  async balancesAt(executor: Executor, userId: string, at: Date): Promise<AccountBalance[]> {
    const result = await executor.execute(sql`
      SELECT DISTINCT ON (account, COALESCE(asset_symbol, ''))
             account, asset_symbol, balance_after AS amount
      FROM ledger_entries
      WHERE user_id = ${userId}::uuid
        AND created_at <= ${at.toISOString()}::timestamptz
      ORDER BY account, COALESCE(asset_symbol, ''), created_at DESC, id DESC
    `);
    return (result.rows as unknown as Array<{ account: LedgerAccount; asset_symbol: string | null; amount: string }>).map(
      (row) => ({ account: row.account, assetSymbol: row.asset_symbol, amount: BigInt(row.amount) }),
    );
  }

  /**
   * Independent recomputation of every balance by folding the raw deltas.
   *
   * This is the integrity check: `SUM(delta)` must equal the materialised
   * projection and the running `balance_after`. Exposed so the test suite — and
   * an operator — can prove the ledger has not drifted.
   */
  async foldBalances(executor: Executor, userId: string, at?: Date): Promise<AccountBalance[]> {
    const result = await executor.execute(sql`
      SELECT account, asset_symbol, SUM(delta)::bigint AS amount
      FROM ledger_entries
      WHERE user_id = ${userId}::uuid
        AND (${at ? at.toISOString() : null}::timestamptz IS NULL
             OR created_at <= ${at ? at.toISOString() : null}::timestamptz)
      GROUP BY account, asset_symbol
      ORDER BY account, COALESCE(asset_symbol, '')
    `);
    return (result.rows as unknown as Array<{ account: LedgerAccount; asset_symbol: string | null; amount: string }>).map(
      (row) => ({ account: row.account, assetSymbol: row.asset_symbol, amount: BigInt(row.amount) }),
    );
  }
}

function comparePostings(a: LedgerPosting, b: LedgerPosting): number {
  return (
    a.userId.localeCompare(b.userId) ||
    a.account.localeCompare(b.account) ||
    (a.assetSymbol ?? '').localeCompare(b.assetSymbol ?? '')
  );
}

function shortfallError(
  account: LedgerAccount,
  assetSymbol: string | null,
  available: bigint,
  required: bigint,
): Error {
  if (account === 'CASH' || account === 'CASH_RESERVED') {
    return new InsufficientFundsException(
      `Insufficient ${account === 'CASH' ? 'available' : 'reserved'} balance: required $${formatCash(required)}, available $${formatCash(available)}.`,
      { account, required: formatCash(required), available: formatCash(available) },
    );
  }
  return new InsufficientSharesException(
    `Insufficient ${assetSymbol ?? 'share'} balance: required ${formatQuantity(required)}, available ${formatQuantity(available)}.`,
    {
      account,
      symbol: assetSymbol,
      required: formatQuantity(required),
      available: formatQuantity(available),
    },
  );
}
