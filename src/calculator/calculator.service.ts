import { Inject, Injectable } from '@nestjs/common';
import { APP_CONFIG, AppConfig } from '../config/configuration';
import { ValidationException } from '../common/errors';
import {
  applyBps,
  bpsBetween,
  floorToLot,
  formatCash,
  formatPrice,
  formatQuantity,
  parseCash,
  parsePrice,
  parseQuantity,
  priceOf,
} from '../common/money';
import { MarketDataService } from '../assets/market-data.service';
import { takeableLevels, walkForNotional, walkForQuantity } from '../assets/order-book';
import { CalculatorRequestDto, CalculatorResponseDto } from './dto/calculator.dto';

/**
 * Order sizing preview.
 *
 * Strictly read-only: no reservations, no ledger entries, no order rows. It
 * walks exactly the same book the matching engine would walk, so the quote it
 * returns is what a market order placed in the same price tick actually pays —
 * including the slippage of sweeping several levels.
 */
@Injectable()
export class CalculatorService {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly marketData: MarketDataService,
  ) {}

  async quote(request: CalculatorRequestDto): Promise<CalculatorResponseDto> {
    const side = request.side ?? 'BUY';
    const asset = this.marketData.requireAsset(request.symbol);
    const snapshot = await this.marketData.getBookSnapshot(asset.symbol);
    // Quote against the mark the book was built from, so slippage is measured
    // against the same instant rather than against a price that has since moved.
    const reference = snapshot.mid;
    const warnings: string[] = [];

    if (request.usdAmount === undefined && request.quantity === undefined) {
      throw new ValidationException('Provide either `usdAmount` or `quantity`.');
    }
    if (request.usdAmount !== undefined && request.quantity !== undefined) {
      throw new ValidationException('`usdAmount` and `quantity` are mutually exclusive.');
    }

    const limitPrice = request.limitPrice
      ? parsePrice(request.limitPrice, 'limitPrice')
      : undefined;
    if (limitPrice !== undefined && limitPrice <= 0n) {
      throw new ValidationException('`limitPrice` must be greater than zero.');
    }

    const levels = takeableLevels(snapshot, side, limitPrice);
    const mode: 'NOTIONAL' | 'QUANTITY' = request.usdAmount !== undefined ? 'NOTIONAL' : 'QUANTITY';

    const walk =
      mode === 'NOTIONAL'
        ? walkForNotional(levels, this.budgetFor(side, request.usdAmount!))
        : walkForQuantity(levels, this.requestedQuantity(request.quantity!, asset.lotSize));

    // Honour the lot size on the way out: a fill is only ever a whole number of lots.
    const quantity = floorToLot(walk.quantity, asset.lotSize);
    const consumed = trimToQuantity(walk.levels, quantity);
    const grossNotional = consumed.reduce((total, level) => total + level.notional, 0n);

    const feeBps = this.config.trading.takerFeeBps;
    const fee = applyBps(grossNotional, feeBps);
    const netCash = side === 'BUY' ? grossNotional + fee : grossNotional - fee;
    const effectivePrice = quantity > 0n ? priceOf(grossNotional, quantity) : reference;

    if (quantity === 0n) {
      warnings.push(
        limitPrice !== undefined
          ? 'No resting liquidity is available at or better than the requested limit price.'
          : 'The requested size rounds to zero at the current lot size.',
      );
    }
    if (walk.exhausted && quantity > 0n) {
      warnings.push(
        'The book cannot absorb the full request; this quote covers the fillable part.',
      );
    }
    if (grossNotional > 0n && grossNotional < asset.minOrderNotional) {
      warnings.push(
        `Below the ${formatCash(asset.minOrderNotional)} minimum order notional for ${asset.symbol}.`,
      );
    }

    return {
      symbol: asset.symbol,
      side,
      mode,
      referencePrice: formatPrice(reference),
      quantity: formatQuantity(quantity),
      grossNotional: formatCash(grossNotional),
      feeBps,
      fee: formatCash(fee),
      netCash: formatCash(netCash),
      effectivePrice: formatPrice(effectivePrice),
      slippageBps: quantity > 0n ? bpsBetween(reference, effectivePrice) : 0,
      fillable: !walk.exhausted && quantity > 0n,
      levels: consumed.map((level) => ({
        price: formatPrice(level.price),
        quantity: formatQuantity(level.quantity),
        notional: formatCash(level.notional),
      })),
      warnings,
      asOf: snapshot.at.toISOString(),
    };
  }

  /**
   * On a BUY the fee is charged on top of the notional, so the amount available
   * to spend on shares is the budget net of the fee it will attract. Solving
   * `gross + gross·f = budget` gives `gross = budget / (1 + f)`, which keeps the
   * *total* debit within what the user asked to spend.
   */
  private budgetFor(side: 'BUY' | 'SELL', usdAmount: string): bigint {
    const amount = parseCash(usdAmount, 'usdAmount');
    if (amount <= 0n) throw new ValidationException('`usdAmount` must be greater than zero.');
    if (side === 'SELL') return amount;

    const feeBps = BigInt(this.config.trading.takerFeeBps);
    return (amount * 10_000n) / (10_000n + feeBps);
  }

  private requestedQuantity(quantity: string, lotSize: bigint): bigint {
    const parsed = parseQuantity(quantity, 'quantity');
    if (parsed <= 0n) throw new ValidationException('`quantity` must be greater than zero.');
    return floorToLot(parsed, lotSize);
  }
}

/** Cut the consumed-level list down so its quantities sum to exactly `quantity`. */
function trimToQuantity(
  levels: readonly { price: bigint; quantity: bigint; notional: bigint }[],
  quantity: bigint,
) {
  const trimmed: Array<{ price: bigint; quantity: bigint; notional: bigint }> = [];
  let remaining = quantity;
  for (const level of levels) {
    if (remaining <= 0n) break;
    if (level.quantity <= remaining) {
      trimmed.push(level);
      remaining -= level.quantity;
    } else {
      trimmed.push({
        price: level.price,
        quantity: remaining,
        notional: (level.notional * remaining) / level.quantity,
      });
      remaining = 0n;
    }
  }
  return trimmed;
}
