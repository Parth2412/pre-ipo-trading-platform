import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Post, Query, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiHeader, ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import { FastifyReply } from 'fastify';
import { CurrentUser } from '../auth/current-user.decorator';
import { AuthenticatedUser } from '../auth/auth.types';
import { IdempotencyKey } from './idempotency-key.decorator';
import { OrdersService } from './orders.service';
import { OrderDto, OrderListQueryDto, PlaceOrderDto, TradeDto, TradeListQueryDto } from './dto/order.dto';

@ApiTags('Orders')
@ApiBearerAuth()
@Controller('orders')
export class OrdersController {
  constructor(private readonly orders: OrdersService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiHeader({
    name: 'Idempotency-Key',
    required: true,
    description:
      'Unique per order — a UUID is ideal. Replaying a key returns the original response ' +
      'instead of placing a second order.',
  })
  @ApiOperation({
    summary: 'Place an order',
    description:
      'Market and limit orders, with partial fills. A GTC limit remainder rests on the book with ' +
      'its funds or shares reserved; an IOC remainder is cancelled and the reservation released.',
  })
  @ApiResponse({ status: 201, type: OrderDto })
  @ApiResponse({ status: 400, description: 'VALIDATION_FAILED / IDEMPOTENCY_KEY_REQUIRED' })
  @ApiResponse({ status: 409, description: 'IDEMPOTENT_REQUEST_IN_FLIGHT' })
  @ApiResponse({ status: 422, description: 'INSUFFICIENT_FUNDS / INSUFFICIENT_SHARES / NO_LIQUIDITY' })
  @ApiResponse({ status: 423, description: 'CIRCUIT_BREAKER_TRIPPED / MARKET_HALTED' })
  async place(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: PlaceOrderDto,
    @IdempotencyKey() idempotencyKey: string,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<OrderDto> {
    const outcome = await this.orders.place(user.id, body, idempotencyKey);
    // Lets a client distinguish "we placed it" from "we already had it".
    void reply.header('Idempotent-Replay', String(outcome.replayed));
    return outcome.order;
  }

  @Get()
  @ApiOperation({ summary: 'List your orders, newest first' })
  @ApiResponse({ status: 200, type: [OrderDto] })
  list(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: OrderListQueryDto,
  ): Promise<OrderDto[]> {
    return this.orders.list(user.id, query);
  }

  @Get('trades')
  @ApiOperation({
    summary: 'List your executions',
    description: 'Every fill, with the position, cost basis and realised P&L that followed it.',
  })
  @ApiResponse({ status: 200, type: [TradeDto] })
  trades(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: TradeListQueryDto,
  ): Promise<TradeDto[]> {
    return this.orders.listTrades(user.id, query);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Fetch one order with its fills' })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiResponse({ status: 200, type: OrderDto })
  @ApiResponse({ status: 404, description: 'ORDER_NOT_FOUND' })
  findOne(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string): Promise<OrderDto> {
    return this.orders.findOne(user.id, id);
  }

  @Delete(':id')
  @ApiOperation({
    summary: 'Cancel a resting order',
    description: 'Releases the unfilled reservation. Filled quantity is unaffected.',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiResponse({ status: 200, type: OrderDto })
  @ApiResponse({ status: 404, description: 'ORDER_NOT_FOUND' })
  @ApiResponse({ status: 409, description: 'ORDER_NOT_CANCELLABLE' })
  cancel(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string): Promise<OrderDto> {
    return this.orders.cancel(user.id, id);
  }
}
