import { Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { Subscription } from 'rxjs';
import { PriceEngineService } from '../assets/price-engine.service';
import { OrdersService } from './orders.service';

/**
 * Drives resting limit orders as the market moves.
 *
 * Without this, a limit order placed away from the touch would sit forever: the
 * only thing that could fill it is another user crossing it. Re-running the
 * matcher on every price tick is what makes limit orders behave like limit
 * orders — and is where most partial fills come from, as a resting order is
 * filled a slice at a time by successive ticks of thin depth.
 *
 * Passes are serialised per process: if the previous run for a symbol has not
 * finished, the tick is skipped rather than queued, so a slow database cannot
 * build an unbounded backlog.
 */
@Injectable()
export class RestingOrdersScheduler implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(RestingOrdersScheduler.name);
  private readonly running = new Set<string>();
  private subscription?: Subscription;

  constructor(
    private readonly priceEngine: PriceEngineService,
    private readonly orders: OrdersService,
  ) {}

  onApplicationBootstrap(): void {
    this.subscription = this.priceEngine.updates.subscribe((update) => {
      void this.run(update.symbol);
    });
    this.logger.log('resting order matcher attached to the price feed');
  }

  onModuleDestroy(): void {
    this.subscription?.unsubscribe();
  }

  private async run(symbol: string): Promise<void> {
    if (this.running.has(symbol)) return;
    this.running.add(symbol);
    try {
      await this.orders.runRestingMatch(symbol);
    } finally {
      this.running.delete(symbol);
    }
  }
}
