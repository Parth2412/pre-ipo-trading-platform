import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { Subject } from 'rxjs';

export type TradingEvent =
  | { readonly type: 'ORDER_UPDATED'; readonly userId: string; readonly order: unknown }
  | {
      readonly type: 'FILL';
      readonly userId: string;
      readonly symbol: string;
      readonly fill: unknown;
    }
  | { readonly type: 'BOOK_CHANGED'; readonly symbol: string };

/**
 * In-process trading event bus.
 *
 * Events are published *after* the transaction that produced them commits, so a
 * subscriber can never observe a fill that later rolls back. Kept free of any
 * dependency on the trading modules so the realtime layer and the engine stay
 * decoupled.
 */
@Injectable()
export class TradingEventsService implements OnModuleDestroy {
  private readonly events$ = new Subject<TradingEvent>();

  get events() {
    return this.events$.asObservable();
  }

  publish(events: readonly TradingEvent[]): void {
    for (const event of events) this.events$.next(event);
  }

  onModuleDestroy(): void {
    this.events$.complete();
  }
}
