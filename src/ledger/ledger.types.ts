import { LedgerAccount, LedgerEntryType } from '../database/schema';

export type { LedgerAccount, LedgerEntryType };

export const CASH: LedgerAccount = 'CASH';
export const CASH_RESERVED: LedgerAccount = 'CASH_RESERVED';
export const POSITION: LedgerAccount = 'POSITION';
export const POSITION_RESERVED: LedgerAccount = 'POSITION_RESERVED';

/**
 * One leg of a double-entry posting.
 *
 * A reservation, a settlement or a deposit is expressed as an array of these,
 * applied atomically. Cash accounts carry `assetSymbol: null`; position
 * accounts must name the asset.
 */
export interface LedgerPosting {
  readonly userId: string;
  readonly account: LedgerAccount;
  readonly assetSymbol: string | null;
  /** Signed change. Negative postings may not drive a balance below zero. */
  readonly delta: bigint;
  readonly entryType: LedgerEntryType;
  readonly refType?: 'ORDER' | 'FILL' | 'ADMIN' | 'SIGNUP';
  readonly refId?: string;
  readonly memo?: string;
}

export interface PostedEntry {
  readonly id: bigint;
  readonly userId: string;
  readonly account: LedgerAccount;
  readonly assetSymbol: string | null;
  readonly delta: bigint;
  readonly balanceAfter: bigint;
  readonly createdAt: Date;
}

export interface AccountBalance {
  readonly account: LedgerAccount;
  readonly assetSymbol: string | null;
  readonly amount: bigint;
}
