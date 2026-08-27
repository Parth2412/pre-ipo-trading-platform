import { Injectable, Logger } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { ConflictException, ErrorCode, UnprocessableException } from '../common/errors';
import { DatabaseService } from '../database/database.service';

export type BeginResult =
  | { readonly outcome: 'PROCEED' }
  | { readonly outcome: 'REPLAY'; readonly status: number; readonly body: unknown };

interface RecordRow {
  request_hash: string;
  status: 'IN_FLIGHT' | 'COMPLETED';
  response_status: number | null;
  response_body: unknown;
}

/**
 * Idempotent request handling for order placement.
 *
 * The concurrency primitive is the table's primary key, not an application-level
 * check. Two racing requests carrying the same key both attempt the INSERT;
 * Postgres lets exactly one win, and the loser is told what happened:
 *
 *   - the original **completed** → its stored response is replayed verbatim,
 *     so a retried request cannot place a second order;
 *   - the original is still **in flight** → `409 IDEMPOTENT_REQUEST_IN_FLIGHT`,
 *     because returning a guess would be worse than asking the client to retry;
 *   - the key was reused with a **different payload** → `422`, since silently
 *     replaying the first response would hide a client bug that is about to
 *     lose someone's order.
 *
 * Records are written in their own transaction, committed before the order
 * transaction begins. An uncommitted marker would be invisible to the
 * concurrent request it exists to block.
 */
@Injectable()
export class IdempotencyService {
  private readonly logger = new Logger(IdempotencyService.name);

  constructor(private readonly database: DatabaseService) {}

  /** Stable hash of a request payload; key order must not change the result. */
  static hashRequest(payload: unknown): string {
    return createHash('sha256').update(canonicalize(payload)).digest('hex');
  }

  async begin(
    userId: string,
    endpoint: string,
    key: string,
    requestHash: string,
  ): Promise<BeginResult> {
    const inserted = await this.database.db.execute(sql`
      INSERT INTO idempotency_records (user_id, endpoint, idempotency_key, request_hash, status)
      VALUES (${userId}::uuid, ${endpoint}::text, ${key}::text, ${requestHash}::text, 'IN_FLIGHT')
      ON CONFLICT (user_id, endpoint, idempotency_key) DO NOTHING
      RETURNING idempotency_key
    `);
    if (inserted.rows.length > 0) return { outcome: 'PROCEED' };

    const existing = await this.database.db.execute(sql`
      SELECT request_hash, status, response_status, response_body
      FROM idempotency_records
      WHERE user_id = ${userId}::uuid
        AND endpoint = ${endpoint}::text
        AND idempotency_key = ${key}::text
    `);
    const record = existing.rows[0] as unknown as RecordRow | undefined;
    if (!record) {
      // The row vanished between the two statements (a concurrent rollback of a
      // failed request). Retrying the insert is the correct response.
      return this.begin(userId, endpoint, key, requestHash);
    }

    if (record.request_hash !== requestHash) {
      throw new UnprocessableException(
        ErrorCode.IDEMPOTENCY_KEY_REUSED,
        'This Idempotency-Key was already used with a different request body. ' +
          'Use a fresh key for a different order.',
        { idempotencyKey: key },
      );
    }

    if (record.status === 'IN_FLIGHT') {
      throw new ConflictException(
        ErrorCode.IDEMPOTENT_REQUEST_IN_FLIGHT,
        'An identical request is still being processed. Retry shortly.',
        { idempotencyKey: key },
      );
    }

    return {
      outcome: 'REPLAY',
      status: record.response_status ?? 200,
      body: record.response_body,
    };
  }

  /** Store the outcome so any later replay of the key returns exactly this. */
  async complete(
    userId: string,
    endpoint: string,
    key: string,
    status: number,
    body: unknown,
  ): Promise<void> {
    await this.database.db.execute(sql`
      UPDATE idempotency_records
         SET status = 'COMPLETED',
             response_status = ${status}::int,
             response_body = ${JSON.stringify(body ?? null)}::jsonb,
             completed_at = clock_timestamp()
       WHERE user_id = ${userId}::uuid
         AND endpoint = ${endpoint}::text
         AND idempotency_key = ${key}::text
    `);
  }

  /**
   * Drop the marker so the client may retry.
   *
   * Used only for unexpected failures. A deliberate rejection (insufficient
   * funds, tripped breaker) is a real outcome and stays recorded, so retrying
   * the same key returns the same rejection rather than re-running the engine.
   */
  async release(userId: string, endpoint: string, key: string): Promise<void> {
    try {
      await this.database.db.execute(sql`
        DELETE FROM idempotency_records
        WHERE user_id = ${userId}::uuid
          AND endpoint = ${endpoint}::text
          AND idempotency_key = ${key}::text
          AND status = 'IN_FLIGHT'
      `);
    } catch (error) {
      this.logger.error(
        `failed to release idempotency key ${key}`,
        error instanceof Error ? error.stack : String(error),
      );
    }
  }
}

/** Deterministic JSON: object keys sorted recursively so key order cannot change the hash. */
function canonicalize(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalize(entry)}`);
  return `{${entries.join(',')}}`;
}
