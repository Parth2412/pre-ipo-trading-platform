import { formatCash, formatPrice, formatQuantity } from '../common/money';
import { MatchingEngineService } from './matching-engine.service';
import { FillRecord, OrderRecord } from './order.types';
import { FillDto, OrderDto, TradeDto } from './dto/order.dto';

export function toFillDto(fill: FillRecord): FillDto {
  return {
    id: fill.id,
    quantity: formatQuantity(fill.quantity),
    price: formatPrice(fill.price),
    notional: formatCash(fill.notional),
    fee: formatCash(fill.fee),
    liquidityRole: fill.liquidityRole,
    counterpartyType: fill.counterpartyType,
    at: fill.createdAt.toISOString(),
  };
}

export function toTradeDto(fill: FillRecord): TradeDto {
  return {
    ...toFillDto(fill),
    orderId: fill.orderId,
    symbol: fill.symbol,
    side: fill.side,
    positionAfter: formatQuantity(fill.postQuantity),
    averageCostAfter: formatPrice(fill.postAvgCost),
    realizedPnlAfter: formatCash(fill.postRealizedPnl),
  };
}

export function toOrderDto(order: OrderRecord, fills: readonly FillRecord[] = []): OrderDto {
  return {
    id: order.id,
    symbol: order.symbol,
    side: order.side,
    type: order.type,
    timeInForce: order.timeInForce,
    status: order.status,
    limitPrice: order.limitPrice === null ? null : formatPrice(order.limitPrice),
    quantity: formatQuantity(order.quantity),
    filledQuantity: formatQuantity(order.filledQuantity),
    remainingQuantity: formatQuantity(order.quantity - order.filledQuantity),
    averageFillPrice: formatPrice(MatchingEngineService.averageFillPrice(order)),
    filledNotional: formatCash(order.filledNotional),
    feesPaid: formatCash(order.feesPaid),
    reservedCash: formatCash(order.reservedCash),
    reservedQuantity: formatQuantity(order.reservedQuantity),
    rejectReason: order.rejectReason,
    fills: fills.map(toFillDto),
    createdAt: order.createdAt.toISOString(),
    updatedAt: order.updatedAt.toISOString(),
  };
}
