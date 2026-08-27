import { Global, Module } from '@nestjs/common';
import { AssetsController } from './assets.controller';
import { CircuitBreakerService } from './circuit-breaker.service';
import { DepthLadderService } from './depth-ladder.service';
import { MarketDataService } from './market-data.service';
import { PriceEngineService } from './price-engine.service';

/**
 * Market data and market state.
 *
 * The circuit breaker lives here rather than in the trading module because it
 * is driven by price observations, not by orders. Trading depends on it; it
 * depends on nothing in trading, which keeps the graph acyclic.
 */
@Global()
@Module({
  controllers: [AssetsController],
  providers: [PriceEngineService, DepthLadderService, MarketDataService, CircuitBreakerService],
  exports: [PriceEngineService, DepthLadderService, MarketDataService, CircuitBreakerService],
})
export class AssetsModule {}
