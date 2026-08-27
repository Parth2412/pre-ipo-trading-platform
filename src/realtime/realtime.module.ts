import { Global, Module } from '@nestjs/common';
import { TradingEventsService } from './trading-events.service';

@Global()
@Module({
  providers: [TradingEventsService],
  exports: [TradingEventsService],
})
export class RealtimeModule {}
