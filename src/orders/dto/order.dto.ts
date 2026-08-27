import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, Matches, Max, Min } from 'class-validator';

const DECIMAL = /^\d+(\.\d+)?$/;

export class PlaceOrderDto {
  @ApiProperty({ example: 'vSOL' })
  @IsString()
  symbol!: string;

  @ApiProperty({ enum: ['BUY', 'SELL'] })
  @IsIn(['BUY', 'SELL'], { message: 'side must be BUY or SELL' })
  side!: 'BUY' | 'SELL';

  @ApiProperty({ enum: ['MARKET', 'LIMIT'] })
  @IsIn(['MARKET', 'LIMIT'], { message: 'type must be MARKET or LIMIT' })
  type!: 'MARKET' | 'LIMIT';

  @ApiPropertyOptional({
    example: '12.5',
    description: 'Share quantity. Required for LIMIT orders and for every SELL.',
  })
  @IsOptional()
  @Matches(DECIMAL, { message: 'quantity must be a positive decimal string' })
  quantity?: string;

  @ApiPropertyOptional({
    example: '5000.00',
    description: 'USD to spend. MARKET BUY only; mutually exclusive with `quantity`.',
  })
  @IsOptional()
  @Matches(DECIMAL, { message: 'usdAmount must be a positive decimal string' })
  usdAmount?: string;

  @ApiPropertyOptional({ example: '415.00', description: 'Required for LIMIT orders.' })
  @IsOptional()
  @Matches(DECIMAL, { message: 'limitPrice must be a positive decimal string' })
  limitPrice?: string;

  @ApiPropertyOptional({
    enum: ['IOC', 'GTC'],
    description:
      'Defaults to IOC for MARKET orders and GTC for LIMIT orders. A GTC remainder rests on ' +
      'the book; an IOC remainder is cancelled immediately.',
  })
  @IsOptional()
  @IsIn(['IOC', 'GTC'], { message: 'timeInForce must be IOC or GTC' })
  timeInForce?: 'IOC' | 'GTC';
}

export class FillDto {
  @ApiProperty() id!: string;
  @ApiProperty({ example: '2.50000000' }) quantity!: string;
  @ApiProperty({ example: '420.250000' }) price!: string;
  @ApiProperty({ example: '1050.625000' }) notional!: string;
  @ApiProperty({ example: '1.050625' }) fee!: string;
  @ApiProperty({ enum: ['TAKER', 'MAKER'] }) liquidityRole!: 'TAKER' | 'MAKER';

  @ApiProperty({
    enum: ['USER', 'SYNTHETIC'],
    description: 'USER when matched against another trader, SYNTHETIC against market-maker depth.',
  })
  counterpartyType!: 'USER' | 'SYNTHETIC';

  @ApiProperty() at!: string;
}

export class OrderDto {
  @ApiProperty() id!: string;
  @ApiProperty({ example: 'vSOL' }) symbol!: string;
  @ApiProperty({ enum: ['BUY', 'SELL'] }) side!: 'BUY' | 'SELL';
  @ApiProperty({ enum: ['MARKET', 'LIMIT'] }) type!: 'MARKET' | 'LIMIT';
  @ApiProperty({ enum: ['IOC', 'GTC'] }) timeInForce!: 'IOC' | 'GTC';

  @ApiProperty({
    enum: ['OPEN', 'PARTIALLY_FILLED', 'FILLED', 'CANCELLED', 'REJECTED'],
    description:
      'OPEN and PARTIALLY_FILLED still have quantity working on the book. FILLED and CANCELLED ' +
      'are terminal.',
  })
  status!: 'OPEN' | 'PARTIALLY_FILLED' | 'FILLED' | 'CANCELLED' | 'REJECTED';

  @ApiProperty({ nullable: true, example: '415.000000' }) limitPrice!: string | null;
  @ApiProperty({ example: '12.50000000' }) quantity!: string;
  @ApiProperty({ example: '8.00000000' }) filledQuantity!: string;
  @ApiProperty({ example: '4.50000000' }) remainingQuantity!: string;
  @ApiProperty({ example: '420.250000', description: 'Volume-weighted average fill price.' })
  averageFillPrice!: string;
  @ApiProperty({ example: '3362.000000' }) filledNotional!: string;
  @ApiProperty({ example: '3.362000' }) feesPaid!: string;

  @ApiProperty({ example: '1875.000000', description: 'Cash still earmarked for this order.' })
  reservedCash!: string;

  @ApiProperty({ example: '0.00000000', description: 'Shares still earmarked for this order.' })
  reservedQuantity!: string;

  @ApiProperty({ nullable: true }) rejectReason!: string | null;
  @ApiProperty({ type: [FillDto] }) fills!: FillDto[];
  @ApiProperty() createdAt!: string;
  @ApiProperty() updatedAt!: string;
}

export class OrderListQueryDto {
  @ApiPropertyOptional({ example: 'vSOL' })
  @IsOptional()
  @IsString()
  symbol?: string;

  @ApiPropertyOptional({ enum: ['OPEN', 'PARTIALLY_FILLED', 'FILLED', 'CANCELLED', 'REJECTED'] })
  @IsOptional()
  @IsIn(['OPEN', 'PARTIALLY_FILLED', 'FILLED', 'CANCELLED', 'REJECTED'])
  status?: 'OPEN' | 'PARTIALLY_FILLED' | 'FILLED' | 'CANCELLED' | 'REJECTED';

  @ApiPropertyOptional({ default: 50, minimum: 1, maximum: 200 })
  @IsOptional()
  @Transform(({ value }) => (value === undefined || value === '' ? undefined : Number(value)))
  @IsInt()
  @Min(1)
  @Max(200)
  limit?: number;

  @ApiPropertyOptional({ default: 0, minimum: 0 })
  @IsOptional()
  @Transform(({ value }) => (value === undefined || value === '' ? undefined : Number(value)))
  @IsInt()
  @Min(0)
  offset?: number;
}

export class TradeListQueryDto {
  @ApiPropertyOptional({ example: 'vSOL' })
  @IsOptional()
  @IsString()
  symbol?: string;

  @ApiPropertyOptional({ default: 50, minimum: 1, maximum: 200 })
  @IsOptional()
  @Transform(({ value }) => (value === undefined || value === '' ? undefined : Number(value)))
  @IsInt()
  @Min(1)
  @Max(200)
  limit?: number;

  @ApiPropertyOptional({ default: 0, minimum: 0 })
  @IsOptional()
  @Transform(({ value }) => (value === undefined || value === '' ? undefined : Number(value)))
  @IsInt()
  @Min(0)
  offset?: number;
}

export class TradeDto extends FillDto {
  @ApiProperty() orderId!: string;
  @ApiProperty({ example: 'vSOL' }) symbol!: string;
  @ApiProperty({ enum: ['BUY', 'SELL'] }) side!: 'BUY' | 'SELL';
  @ApiProperty({ example: '10.00000000', description: 'Position size after this fill.' })
  positionAfter!: string;
  @ApiProperty({ example: '418.200000', description: 'Average cost after this fill.' })
  averageCostAfter!: string;
  @ApiProperty({ example: '125.500000', description: 'Cumulative realised P&L after this fill.' })
  realizedPnlAfter!: string;
}
