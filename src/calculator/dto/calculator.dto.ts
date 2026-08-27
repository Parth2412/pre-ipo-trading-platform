import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString, Matches } from 'class-validator';

const DECIMAL = /^\d+(\.\d+)?$/;

export class CalculatorRequestDto {
  @ApiProperty({ example: 'vSOL' })
  @IsString()
  symbol!: string;

  @ApiPropertyOptional({ enum: ['BUY', 'SELL'], default: 'BUY' })
  @IsOptional()
  @IsIn(['BUY', 'SELL'], { message: 'side must be BUY or SELL' })
  side?: 'BUY' | 'SELL';

  @ApiPropertyOptional({
    example: '5000.00',
    description: 'USD to spend (BUY) or to raise (SELL). Mutually exclusive with `quantity`.',
  })
  @IsOptional()
  @Matches(DECIMAL, { message: 'usdAmount must be a positive decimal string' })
  usdAmount?: string;

  @ApiPropertyOptional({
    example: '12.5',
    description: 'Share quantity to price. Mutually exclusive with `usdAmount`.',
  })
  @IsOptional()
  @Matches(DECIMAL, { message: 'quantity must be a positive decimal string' })
  quantity?: string;

  @ApiPropertyOptional({
    example: '415.00',
    description: 'Price the quote a limit order instead of a sweep of the book.',
  })
  @IsOptional()
  @Matches(DECIMAL, { message: 'limitPrice must be a positive decimal string' })
  limitPrice?: string;
}

export class CalculatorLevelDto {
  @ApiProperty({ example: '420.250000' }) price!: string;
  @ApiProperty({ example: '8.20000000' }) quantity!: string;
  @ApiProperty({ example: '3446.050000' }) notional!: string;
}

export class CalculatorResponseDto {
  @ApiProperty({ example: 'vSOL' }) symbol!: string;
  @ApiProperty({ enum: ['BUY', 'SELL'] }) side!: 'BUY' | 'SELL';

  @ApiProperty({
    enum: ['NOTIONAL', 'QUANTITY'],
    description: 'NOTIONAL when priced from `usdAmount`, QUANTITY when priced from `quantity`.',
  })
  mode!: 'NOTIONAL' | 'QUANTITY';

  @ApiProperty({ example: '420.000000', description: 'Mid mark at the time of the quote.' })
  referencePrice!: string;

  @ApiProperty({ example: '11.83000000', description: 'Shares obtainable, floored to the lot size.' })
  quantity!: string;

  @ApiProperty({ example: '4972.560000', description: 'Notional before fees.' })
  grossNotional!: string;

  @ApiProperty({ example: 10 }) feeBps!: number;
  @ApiProperty({ example: '4.972560' }) fee!: string;

  @ApiProperty({
    example: '4977.532560',
    description: 'Cash debited on a BUY, or credited on a SELL, after fees.',
  })
  netCash!: string;

  @ApiProperty({ example: '420.250000', description: 'Volume-weighted price across consumed levels.' })
  effectivePrice!: string;

  @ApiProperty({ example: 6, description: 'Effective price versus reference price, in bps.' })
  slippageBps!: number;

  @ApiProperty({ description: 'False when the book could not absorb the full request.' })
  fillable!: boolean;

  @ApiProperty({ type: [CalculatorLevelDto], description: 'Book levels the order would consume.' })
  levels!: CalculatorLevelDto[];

  @ApiProperty({ type: [String], example: [] })
  warnings!: string[];

  @ApiProperty() asOf!: string;
}
