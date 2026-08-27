import { Inject, Injectable } from '@nestjs/common';
import { APP_CONFIG, AppConfig } from '../config/configuration';
import { SeededRandom, hashString } from '../common/random';
import {
  BPS_SCALE,
  divRoundUp,
  floorToLot,
  maxBigInt,
  parseCash,
  quantityForNotional,
  roundToTick,
} from '../common/money';
import { BookLevel } from './order-book';

export interface LadderParameters {
  readonly symbol: string;
  readonly tickSize: bigint;
  readonly lotSize: bigint;
  /** Annualised volatility in bps; wider spreads are quoted on more volatile names. */
  readonly annualVolBps: number;
}

export interface SyntheticLadder {
  readonly bids: readonly BookLevel[];
  readonly asks: readonly BookLevel[];
}

/**
 * Synthetic market-maker depth: the counterparty of last resort.
 *
 * The platform matches users against each other first (price-time priority);
 * whatever is left over trades against this ladder. Without it a lone user on
 * an empty book could never fill, which makes the product undemonstrable.
 *
 * Depth is *derived* rather than stored, from a generator seeded with
 * `(symbol, price bucket)`. That gives two properties worth having:
 *   - within one price tick the ladder is stable, so a quote from
 *     `POST /calculator` matches what a market order actually pays;
 *   - across restarts the same market replays identically.
 *
 * Sizes grow with depth and the quoted spread widens with volatility, so
 * sweeping a large order costs progressively more — real slippage, not a flat
 * fill at mid.
 */
@Injectable()
export class DepthLadderService {
  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  build(parameters: LadderParameters, mid: bigint): SyntheticLadder {
    const { bookLevels, bookSpreadBps, bookNotionalPerLevelUsd } = this.config.market;

    // Wider markets on more volatile names: 12 bps base + 1 bp per 10 vol points.
    const spreadBps = BigInt(Math.round(bookSpreadBps + parameters.annualVolBps / 1000));
    const halfSpread = maxBigInt(
      roundToTick(divRoundUp(mid * spreadBps, BPS_SCALE * 2n), parameters.tickSize),
      parameters.tickSize,
    );
    const step = maxBigInt(
      roundToTick(divRoundUp(mid * 3n, BPS_SCALE), parameters.tickSize),
      parameters.tickSize,
    );

    const bestBid = maxBigInt(mid - halfSpread, parameters.tickSize);
    const bestAsk = mid + halfSpread;
    const notionalPerLevel = parseCash(String(bookNotionalPerLevelUsd));

    // Bucket by tick so the ladder is stable for the life of a price tick.
    const bucket = Number(mid / maxBigInt(parameters.tickSize, 1n)) | 0;
    const random = new SeededRandom(hashString(parameters.symbol) ^ bucket);

    const bids: BookLevel[] = [];
    const asks: BookLevel[] = [];
    for (let level = 0; level < bookLevels; level += 1) {
      const depthFactor = 1 + level * 0.35;
      const bidPrice = maxBigInt(bestBid - step * BigInt(level), parameters.tickSize);
      const askPrice = bestAsk + step * BigInt(level);

      bids.push({
        price: bidPrice,
        quantity: this.sizeFor(notionalPerLevel, bidPrice, depthFactor, random, parameters.lotSize),
      });
      asks.push({
        price: askPrice,
        quantity: this.sizeFor(notionalPerLevel, askPrice, depthFactor, random, parameters.lotSize),
      });
    }

    return {
      bids: bids.filter((level) => level.quantity > 0n),
      asks: asks.filter((level) => level.quantity > 0n),
    };
  }

  private sizeFor(
    notionalPerLevel: bigint,
    price: bigint,
    depthFactor: number,
    random: SeededRandom,
    lotSize: bigint,
  ): bigint {
    const jitter = random.nextInRange(0.7, 1.3);
    const scaled = BigInt(Math.round(Number(notionalPerLevel) * depthFactor * jitter));
    return floorToLot(quantityForNotional(scaled, price), lotSize);
  }
}
