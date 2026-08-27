/**
 * Fixed-point decimal arithmetic for money, prices and share quantities.
 *
 * Rationale
 * ---------
 * IEEE-754 doubles cannot represent 0.1 exactly, so a ledger built on `number`
 * accumulates drift that eventually breaks the invariant
 * `sum(ledger deltas) === materialised balance`. Every monetary value in this
 * platform is therefore a `bigint` holding a *scaled integer*:
 *
 *   price      1e6  → $420.00        is 420_000_000n
 *   quantity   1e8  → 1.5 shares     is 150_000_000n
 *   cash       1e6  → $1,234.56      is 1_234_560_000n
 *
 * Addition and subtraction are exact. Multiplication and division are the only
 * lossy operations, so they are funnelled through the helpers below which apply
 * one explicit rounding rule: half-up on magnitude (round-half-away-from-zero).
 * Fees round *up* so the venue is never short-changed by a rounding remainder.
 */

export const PRICE_SCALE = 1_000_000n; // 6 decimal places
export const QTY_SCALE = 100_000_000n; // 8 decimal places
export const CASH_SCALE = 1_000_000n; // 6 decimal places
export const BPS_SCALE = 10_000n; // 1 bp = 0.01%

export const PRICE_DECIMALS = 6;
export const QTY_DECIMALS = 8;
export const CASH_DECIMALS = 6;

/** Branded aliases: purely documentary, but they make signatures self-describing. */
export type Price = bigint;
export type Quantity = bigint;
export type Cash = bigint;

function absBigInt(value: bigint): bigint {
  return value < 0n ? -value : value;
}

/** Divide with round-half-away-from-zero. `divisor` must be positive. */
export function divRoundHalfUp(dividend: bigint, divisor: bigint): bigint {
  if (divisor <= 0n) throw new RangeError('divisor must be positive');
  const sign = dividend < 0n ? -1n : 1n;
  const magnitude = absBigInt(dividend);
  return sign * ((magnitude * 2n + divisor) / (divisor * 2n));
}

/** Divide, always rounding the magnitude *down* (truncate toward zero). */
export function divRoundDown(dividend: bigint, divisor: bigint): bigint {
  if (divisor <= 0n) throw new RangeError('divisor must be positive');
  const sign = dividend < 0n ? -1n : 1n;
  return sign * (absBigInt(dividend) / divisor);
}

/** Divide, always rounding the magnitude *up*. Used for fees and margin. */
export function divRoundUp(dividend: bigint, divisor: bigint): bigint {
  if (divisor <= 0n) throw new RangeError('divisor must be positive');
  const sign = dividend < 0n ? -1n : 1n;
  const magnitude = absBigInt(dividend);
  return sign * ((magnitude + divisor - 1n) / divisor);
}

/**
 * notional = price × quantity, expressed in cash units.
 *
 * price(1e6) × qty(1e8) = 1e14, so dividing by QTY_SCALE(1e8) lands on the
 * cash scale (1e6) exactly. Rounds half-up.
 */
export function notionalOf(price: Price, quantity: Quantity): Cash {
  return divRoundHalfUp(price * quantity, QTY_SCALE);
}

/**
 * quantity = cash / price, expressed in quantity units.
 *
 * Rounded *down* so that a buyer converting a fixed USD amount can never be
 * allocated more shares than the amount actually pays for.
 */
export function quantityForNotional(notional: Cash, price: Price): Quantity {
  if (price <= 0n) throw new RangeError('price must be positive');
  return divRoundDown(notional * QTY_SCALE, price);
}

/** Effective price implied by a notional and a quantity. Rounds half-up. */
export function priceOf(notional: Cash, quantity: Quantity): Price {
  if (quantity <= 0n) throw new RangeError('quantity must be positive');
  return divRoundHalfUp(notional * QTY_SCALE, quantity);
}

/** Apply a basis-point rate to a cash amount, rounding the fee up. */
export function applyBps(amount: Cash, bps: number): Cash {
  if (bps === 0) return 0n;
  return divRoundUp(amount * BigInt(Math.round(bps)), BPS_SCALE);
}

/** Basis-point difference between two prices, relative to `from`. Always >= 0. */
export function bpsBetween(from: Price, to: Price): number {
  if (from === 0n) return 0;
  const diff = absBigInt(to - from);
  return Number((diff * BPS_SCALE) / absBigInt(from));
}

/** Round a price to the nearest tick (ties away from zero). */
export function roundToTick(price: Price, tickSize: bigint): Price {
  if (tickSize <= 0n) return price;
  return divRoundHalfUp(price, tickSize) * tickSize;
}

/** Round a quantity down to a whole multiple of the lot size. */
export function floorToLot(quantity: Quantity, lotSize: bigint): Quantity {
  if (lotSize <= 0n) return quantity;
  return (quantity / lotSize) * lotSize;
}

export function minBigInt(a: bigint, b: bigint): bigint {
  return a < b ? a : b;
}

export function maxBigInt(a: bigint, b: bigint): bigint {
  return a > b ? a : b;
}

/** Render a scaled integer as a plain decimal string, e.g. 420_000_000n → "420.000000". */
export function formatScaled(value: bigint, decimals: number): string {
  const scale = 10n ** BigInt(decimals);
  const sign = value < 0n ? '-' : '';
  const magnitude = absBigInt(value);
  const whole = magnitude / scale;
  const fraction = magnitude % scale;
  if (decimals === 0) return `${sign}${whole}`;
  return `${sign}${whole}.${fraction.toString().padStart(decimals, '0')}`;
}

export const formatPrice = (value: Price) => formatScaled(value, PRICE_DECIMALS);
export const formatQuantity = (value: Quantity) => formatScaled(value, QTY_DECIMALS);
export const formatCash = (value: Cash) => formatScaled(value, CASH_DECIMALS);

/**
 * Parse a decimal string/number into a scaled integer.
 *
 * Rejects anything that is not a finite decimal literal and anything with more
 * precision than the target scale, rather than silently truncating a user's
 * order size.
 */
export function parseScaled(input: string | number, decimals: number, field = 'value'): bigint {
  const raw = typeof input === 'number' ? numberToDecimalString(input, field) : input.trim();
  if (!/^-?\d+(\.\d+)?$/.test(raw)) {
    throw new RangeError(`${field} must be a decimal number, received "${raw}"`);
  }
  const negative = raw.startsWith('-');
  const [whole, fraction = ''] = (negative ? raw.slice(1) : raw).split('.');
  if (fraction.length > decimals) {
    throw new RangeError(`${field} supports at most ${decimals} decimal places, received "${raw}"`);
  }
  const scaled = BigInt(whole + fraction.padEnd(decimals, '0'));
  return negative ? -scaled : scaled;
}

function numberToDecimalString(input: number, field: string): string {
  if (!Number.isFinite(input)) {
    throw new RangeError(`${field} must be a finite number`);
  }
  // toFixed(20) then trim keeps small decimals out of exponential notation.
  return input.toFixed(20).replace(/0+$/, '').replace(/\.$/, '');
}

export const parsePrice = (input: string | number, field = 'price') =>
  parseScaled(input, PRICE_DECIMALS, field);
export const parseQuantity = (input: string | number, field = 'quantity') =>
  parseScaled(input, QTY_DECIMALS, field);
export const parseCash = (input: string | number, field = 'amount') =>
  parseScaled(input, CASH_DECIMALS, field);

/** Convert a scaled integer to a JS number. Lossy — presentation and maths on charts only. */
export function toNumber(value: bigint, decimals: number): number {
  return Number(formatScaled(value, decimals));
}
