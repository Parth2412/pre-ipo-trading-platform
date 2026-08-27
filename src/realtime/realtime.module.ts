import { Global, Module } from '@nestjs/common';
import { MarketStreamGateway } from './market-stream.gateway';
import { TradingEventsService } from './trading-events.service';

@Global()
@Module({
  providers: [TradingEventsService, MarketStreamGateway],
  exports: [TradingEventsService],
})
export class RealtimeModule {}
