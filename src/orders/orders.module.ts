import { Module } from '@nestjs/common';
import { IdempotencyService } from './idempotency.service';
import { MatchingEngineService } from './matching-engine.service';
import { OrdersController } from './orders.controller';
import { OrdersRepository } from './orders.repository';
import { OrdersService } from './orders.service';
import { RestingOrdersScheduler } from './resting-orders.scheduler';

@Module({
  controllers: [OrdersController],
  providers: [
    OrdersRepository,
    MatchingEngineService,
    IdempotencyService,
    OrdersService,
    RestingOrdersScheduler,
  ],
  exports: [OrdersRepository, MatchingEngineService, OrdersService],
})
export class OrdersModule {}
