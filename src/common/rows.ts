/**
 * Row coercion helpers for raw SQL results.
 *
 * `drizzle.execute()` returns column values exactly as the driver produced
 * them — BIGINT and TIMESTAMPTZ both arrive as strings. Coercing at the query
 * boundary (rather than trusting an implicit conversion) keeps the rest of the
 * codebase working in `bigint` and `Date`, and makes a shape mismatch fail here
 * instead of three layers up.
 */

export function asBigInt(value: unknown): bigint {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number') return BigInt(Math.trunc(value));
  if (typeof value === 'string' && value.trim() !== '') return BigInt(value);
  throw new TypeError(`Expected a numeric value, received ${JSON.stringify(value)}`);
}

export function asBigIntOrNull(value: unknown): bigint | null {
  return value === null || value === undefined ? null : asBigInt(value);
}

export function asNumber(value: unknown): number {
  if (typeof value === 'number') return value;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new TypeError(`Expected a number, received ${JSON.stringify(value)}`);
  }
  return parsed;
}

/**
 * Postgres renders TIMESTAMPTZ as `2026-08-27 15:04:11.256151+00`, which is not
 * ISO-8601: the date and time are space-separated and the offset omits minutes.
 * Both are normalised before parsing rather than relying on lenient engine
 * behaviour.
 */
export function asDate(value: unknown): Date {
  if (value instanceof Date) return value;
  if (typeof value !== 'string') {
    throw new TypeError(`Expected a timestamp, received ${JSON.stringify(value)}`);
  }

  const withT = value.trim().replace(' ', 'T');
  const withOffset = /([+-]\d{2})$/.test(withT) ? `${withT}:00` : withT;
  const zoned = /([zZ]|[+-]\d{2}:\d{2})$/.test(withOffset) ? withOffset : `${withOffset}Z`;

  const date = new Date(zoned);
  if (Number.isNaN(date.getTime())) {
    throw new TypeError(`Unparseable timestamp: ${value}`);
  }
  return date;
}

export function asDateOrNull(value: unknown): Date | null {
  return value === null || value === undefined ? null : asDate(value);
}
