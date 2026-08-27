import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsInt, IsISO8601, IsOptional, Max, Min } from 'class-validator';

export class CircuitBreakerDto {
  @ApiProperty({ description: 'True while new orders on this asset are being rejected.' })
  tripped!: boolean;

  @ApiProperty({ description: 'Largest peak-to-trough move observed in the rolling window, in bps.' })
  moveBps!: number;

  @ApiProperty({ example: 1500 })
  thresholdBps!: number;

  @ApiProperty({ example: 60000 })
  windowMs!: number;

  @ApiPropertyOptional({ description: 'When trading resumes. Null while the breaker is idle.' })
  resumesAt!: string | null;
}

export class PriceStatsDto {
  @ApiProperty({ example: '420.000000' }) open!: string;
  @ApiProperty({ example: '441.230000' }) high!: string;
  @ApiProperty({ example: '405.110000' }) low!: string;
  @ApiProperty({ example: '432.900000' }) last!: string;
  @ApiProperty({ example: 307, description: 'Change from open, in basis points.' }) changeBps!: number;
  @ApiProperty({ example: 864 }) ticks!: number;
}

export class AssetDto {
  @ApiProperty({ example: 'vSOL' }) symbol!: string;
  @ApiProperty({ example: 'Solace AI' }) name!: string;
  @ApiProperty({ example: 'Artificial Intelligence' }) sector!: string;
  @ApiProperty() description!: string;
  @ApiProperty({ enum: ['ACTIVE', 'HALTED'] }) status!: 'ACTIVE' | 'HALTED';

  @ApiProperty({ example: '420.000000', description: 'Last simulated mark price.' })
  price!: string;

  @ApiProperty({ example: '419.750000', description: 'Best bid across user and synthetic liquidity.' })
  bid!: string;

  @ApiProperty({ example: '420.250000', description: 'Best ask across user and synthetic liquidity.' })
  ask!: string;

  @ApiProperty({ example: 12, description: 'Quoted spread in basis points.' })
  spreadBps!: number;

  @ApiProperty({ example: '0.010000' }) tickSize!: string;
  @ApiProperty({ example: '0.00001000' }) lotSize!: string;
  @ApiProperty({ example: '1.000000' }) minOrderNotional!: string;
  @ApiProperty({ example: 7000, description: 'Annualised volatility used by the price process, in bps.' })
  annualVolBps!: number;

  @ApiPropertyOptional({ type: PriceStatsDto, nullable: true })
  stats24h!: PriceStatsDto | null;

  @ApiProperty({ type: CircuitBreakerDto })
  circuitBreaker!: CircuitBreakerDto;

  @ApiProperty() asOf!: string;
}

export class BookLevelDto {
  @ApiProperty({ example: '420.250000' }) price!: string;
  @ApiProperty({ example: '59.51000000' }) quantity!: string;
  @ApiProperty({ example: '25000.000000' }) notional!: string;
}

export class OrderBookDto {
  @ApiProperty({ example: 'vSOL' }) symbol!: string;
  @ApiProperty({ example: '420.000000' }) mid!: string;
  @ApiProperty({ type: [BookLevelDto], description: 'Highest price first.' }) bids!: BookLevelDto[];
  @ApiProperty({ type: [BookLevelDto], description: 'Lowest price first.' }) asks!: BookLevelDto[];
  @ApiProperty() asOf!: string;
}

export class AssetDetailDto extends AssetDto {
  @ApiProperty({ type: OrderBookDto })
  book!: OrderBookDto;
}

export class PricePointDto {
  @ApiProperty({ example: '420.000000' }) price!: string;
  @ApiProperty({ example: '2026-08-27T12:00:00.000Z' }) at!: string;
}

export class PriceHistoryDto {
  @ApiProperty({ example: 'vSOL' }) symbol!: string;
  @ApiProperty({ type: [PricePointDto], description: 'Oldest first.' }) points!: PricePointDto[];
  @ApiProperty({ example: 240 }) count!: number;
}

export class PriceHistoryQueryDto {
  @ApiPropertyOptional({ description: 'ISO-8601 lower bound (inclusive).' })
  @IsOptional()
  @IsISO8601({ strict: true }, { message: 'from must be an ISO-8601 timestamp' })
  from?: string;

  @ApiPropertyOptional({ description: 'ISO-8601 upper bound (inclusive).' })
  @IsOptional()
  @IsISO8601({ strict: true }, { message: 'to must be an ISO-8601 timestamp' })
  to?: string;

  @ApiPropertyOptional({ default: 200, minimum: 1, maximum: 1000 })
  @IsOptional()
  @Transform(({ value }) => (value === undefined || value === '' ? undefined : Number(value)))
  @IsInt({ message: 'limit must be an integer' })
  @Min(1)
  @Max(1000)
  limit?: number;
}

export class OrderBookQueryDto {
  @ApiPropertyOptional({ default: 10, minimum: 1, maximum: 50 })
  @IsOptional()
  @Transform(({ value }) => (value === undefined || value === '' ? undefined : Number(value)))
  @IsInt({ message: 'depth must be an integer' })
  @Min(1)
  @Max(50)
  depth?: number;
}
