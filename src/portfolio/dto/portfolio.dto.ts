import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsBoolean, IsInt, IsISO8601, IsOptional, Max, Min } from 'class-validator';

const toBoolean = ({ value }: { value: unknown }) =>
  value === undefined || value === '' ? undefined : value === true || value === 'true' || value === '1';

const toNumber = ({ value }: { value: unknown }) =>
  value === undefined || value === '' ? undefined : Number(value);

export class HoldingDto {
  @ApiProperty({ example: 'vSOL' }) symbol!: string;
  @ApiProperty({ example: 'Solace AI' }) name!: string;

  @ApiProperty({ example: '45.66966000', description: 'Total shares held, reserved included.' })
  quantity!: string;

  @ApiProperty({ example: '40.66966000', description: 'Freely sellable shares.' })
  availableQuantity!: string;

  @ApiProperty({ example: '5.00000000', description: 'Shares earmarked for resting SELL orders.' })
  reservedQuantity!: string;

  @ApiProperty({ example: '437.489967', description: 'Weighted average cost per share, fees included.' })
  averageCost!: string;

  @ApiProperty({ example: '19980.018067' }) costBasis!: string;
  @ApiProperty({ example: '440.120000', description: 'Mark price used for valuation.' })
  markPrice!: string;
  @ApiProperty({ example: '20100.140000' }) marketValue!: string;
  @ApiProperty({ example: '120.121933' }) unrealizedPnl!: string;
  @ApiProperty({ example: 60, description: 'Unrealised P&L against cost basis, in basis points.' })
  unrealizedPnlBps!: number;
  @ApiProperty({ example: '0.000000', description: 'Cumulative realised P&L in this asset.' })
  realizedPnl!: string;
  @ApiProperty({ example: 812, description: 'Share of total portfolio equity, in basis points.' })
  weightBps!: number;
}

export class CashDto {
  @ApiProperty({ example: '223343.240784', description: 'Spendable stablecoin.' })
  available!: string;
  @ApiProperty({ example: '1251.250000', description: 'Earmarked for resting BUY orders.' })
  reserved!: string;
  @ApiProperty({ example: '224594.490784' }) total!: string;
}

export class PortfolioTotalsDto {
  @ApiProperty({ example: '224594.490784' }) cash!: string;
  @ApiProperty({ example: '20100.140000' }) positionsValue!: string;
  @ApiProperty({ example: '244694.630784', description: 'Cash plus the marked value of every holding.' })
  equity!: string;
  @ApiProperty({ example: '19980.018067' }) costBasis!: string;
  @ApiProperty({ example: '120.121933' }) unrealizedPnl!: string;
  @ApiProperty({ example: '-6.088800' }) realizedPnl!: string;
  @ApiProperty({ example: '114.033133', description: 'Realised plus unrealised.' })
  totalPnl!: string;
  @ApiProperty({ example: '250000.000000', description: 'Deposits less withdrawals to date.' })
  netDeposits!: string;
  @ApiProperty({
    example: -21,
    description: 'Equity against net deposits, in basis points. The true return on the account.',
  })
  totalReturnBps!: number;
}

export class ReconciliationDto {
  @ApiProperty({
    description:
      'True when the O(log n) running-balance read and the independent full ledger fold agree exactly.',
  })
  consistent!: boolean;

  @ApiProperty({ example: '0.000000', description: 'Cash difference between the two methods.' })
  cashDrift!: string;

  @ApiProperty({
    type: [String],
    example: [],
    description: 'Symbols where the snapshot and the fill replay disagree. Empty means clean.',
  })
  positionDrift!: string[];

  @ApiProperty({ example: 3, description: 'Ledger entries folded during verification.' })
  ledgerEntriesFolded!: number;

  @ApiProperty({ example: 4, description: 'Fills replayed during verification.' })
  fillsReplayed!: number;
}

export class PortfolioDto {
  @ApiProperty({
    example: '2026-08-27T15:30:00.000Z',
    description: 'The instant this portfolio represents.',
  })
  asOf!: string;

  @ApiProperty({
    enum: ['LIVE', 'HISTORICAL'],
    description: 'HISTORICAL when reconstructed at a past timestamp.',
  })
  mode!: 'LIVE' | 'HISTORICAL';

  @ApiProperty({ type: CashDto }) cash!: CashDto;
  @ApiProperty({ type: [HoldingDto] }) holdings!: HoldingDto[];
  @ApiProperty({ type: PortfolioTotalsDto }) totals!: PortfolioTotalsDto;

  @ApiPropertyOptional({
    type: ReconciliationDto,
    description: 'Present when `verify=true`. Proves the fast path matches a full recomputation.',
  })
  reconciliation?: ReconciliationDto;
}

export class PortfolioQueryDto {
  @ApiPropertyOptional({
    description: 'Also recompute from the raw ledger and report any drift.',
    default: false,
  })
  @IsOptional()
  @Transform(toBoolean)
  @IsBoolean()
  verify?: boolean;
}

export class PortfolioHistoryQueryDto extends PortfolioQueryDto {
  @ApiProperty({
    example: '2026-08-27T12:00:00.000Z',
    description: 'ISO-8601 instant to reconstruct the portfolio at.',
  })
  @IsISO8601({ strict: true }, { message: 'at must be an ISO-8601 timestamp' })
  at!: string;
}

export class PortfolioTimelineQueryDto {
  @ApiPropertyOptional({ description: 'ISO-8601 start. Defaults to the account’s first activity.' })
  @IsOptional()
  @IsISO8601({ strict: true }, { message: 'from must be an ISO-8601 timestamp' })
  from?: string;

  @ApiPropertyOptional({ description: 'ISO-8601 end. Defaults to now.' })
  @IsOptional()
  @IsISO8601({ strict: true }, { message: 'to must be an ISO-8601 timestamp' })
  to?: string;

  @ApiPropertyOptional({ default: 24, minimum: 2, maximum: 200 })
  @IsOptional()
  @Transform(toNumber)
  @IsInt()
  @Min(2)
  @Max(200)
  points?: number;
}

export class EquityPointDto {
  @ApiProperty() at!: string;
  @ApiProperty({ example: '244694.630784' }) equity!: string;
  @ApiProperty({ example: '224594.490784' }) cash!: string;
  @ApiProperty({ example: '20100.140000' }) positionsValue!: string;
  @ApiProperty({ example: '114.033133' }) totalPnl!: string;
}

export class EquityCurveDto {
  @ApiProperty({ type: [EquityPointDto] }) points!: EquityPointDto[];
  @ApiProperty() from!: string;
  @ApiProperty() to!: string;
}

export class LedgerEntryDto {
  @ApiProperty({ example: '1042' }) id!: string;
  @ApiProperty({ enum: ['CASH', 'CASH_RESERVED', 'POSITION', 'POSITION_RESERVED'] })
  account!: string;
  @ApiProperty({ nullable: true, example: 'vSOL' }) symbol!: string | null;
  @ApiProperty({ example: '-19980.018067' }) delta!: string;
  @ApiProperty({ example: '223343.240784' }) balanceAfter!: string;
  @ApiProperty({ example: 'TRADE_BUY' }) entryType!: string;
  @ApiProperty({ nullable: true }) reference!: string | null;
  @ApiProperty({ example: 'BUY 45.66966000 vSOL @ 437.489967' }) memo!: string;
  @ApiProperty() at!: string;
}

export class LedgerQueryDto {
  @ApiPropertyOptional({ default: 100, minimum: 1, maximum: 500 })
  @IsOptional()
  @Transform(toNumber)
  @IsInt()
  @Min(1)
  @Max(500)
  limit?: number;

  @ApiPropertyOptional({ default: 0, minimum: 0 })
  @IsOptional()
  @Transform(toNumber)
  @IsInt()
  @Min(0)
  offset?: number;
}
